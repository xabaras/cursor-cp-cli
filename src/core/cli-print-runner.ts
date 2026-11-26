/**
 * Run Cursor CLI headless (`agent -p --resume`) and collect assistant text.
 * Supports multiple concurrent processes keyed by CLI chatId.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { logger } from '../util/logger.js';

export type CliPrintMode = 'agent' | 'plan' | 'ask';

export interface CliPrintRunOptions {
  agentBin: string;
  chatId: string;
  cwd: string;
  prompt: string;
  /** agent = default (no --mode); plan/ask pass --mode to the CLI. */
  mode?: CliPrintMode;
  force?: boolean;
  trust?: boolean;
  /** 0 or negative = no timeout kill. */
  timeoutMs?: number;
  apiKey?: string;
  onChunk?: (text: string) => void;
}

export interface CliPrintRunResult {
  success: boolean;
  text: string;
  error?: string;
  exitCode: number | null;
  /** Length of terminal `result` event text (before prefer-longer). */
  resultLen?: number;
  /** Length of accumulated assistant segment text (before prefer-longer). */
  assistantLen?: number;
}

/** Prefer the longer of CLI `result` vs accumulated assistant segments. */
export function preferLongerCliText(resultText: string, assistantText: string): string {
  const a = assistantText.trim();
  const r = resultText.trim();
  if (!r) return a;
  if (!a) return r;
  return a.length > r.length ? a : r;
}

export class CliPrintRunner {
  /** Active child processes keyed by CLI chatId. */
  private children = new Map<string, ChildProcess>();

  async run(options: CliPrintRunOptions): Promise<CliPrintRunResult> {
    if (this.children.has(options.chatId)) {
      return {
        success: false,
        text: '',
        error: `A CLI run is already in progress for chat ${options.chatId}`,
        exitCode: null,
      };
    }

    const args = [
      '-p',
      '--resume',
      options.chatId,
      '--workspace',
      options.cwd,
      '--output-format',
      'stream-json',
    ];
    if (options.trust !== false) args.push('--trust');
    if (options.force !== false) args.push('--force');
    const mode = options.mode ?? 'agent';
    if (mode === 'plan' || mode === 'ask') {
      args.push('--mode', mode);
    }
    args.push(options.prompt);

    const env = { ...process.env };
    if (options.apiKey) {
      env.CURSOR_API_KEY = options.apiKey;
    }

    logger.info(
      { chatId: options.chatId, cwd: options.cwd, agentBin: options.agentBin, mode },
      'Starting CLI print run'
    );

    const child = spawn(options.agentBin, args, {
      env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(options.chatId, child);

    let assistantText = '';
    let resultText = '';
    let stderr = '';
    const timeoutMs = options.timeoutMs ?? 0;

    if (!child.stdout || !child.stderr) {
      this.children.delete(options.chatId);
      return {
        success: false,
        text: '',
        error: 'Failed to capture CLI stdout/stderr',
        exitCode: null,
      };
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const parsed = parseStreamJsonLine(line);
      if (!parsed) return;
      if (parsed.delta) {
        assistantText += parsed.delta;
        options.onChunk?.(parsed.delta);
      }
      if (parsed.result != null) {
        resultText = parsed.result;
      }
    });

    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString();
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }));
        child.on('error', (err) => {
          stderr += err.message;
          resolve({ code: 1, signal: null });
        });
      }
    );

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        this.cancel(options.chatId);
      }, timeoutMs);
    }

    const { code, signal } = await exitPromise;
    if (timer) clearTimeout(timer);
    rl.close();
    this.children.delete(options.chatId);

    const resultLen = resultText.trim().length;
    const assistantLen = assistantText.trim().length;
    const text = preferLongerCliText(resultText, assistantText);
    if (timedOut) {
      return {
        success: false,
        text,
        error: `CLI run timed out after ${timeoutMs}ms`,
        exitCode: code,
        resultLen,
        assistantLen,
      };
    }

    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      return {
        success: false,
        text,
        error: 'CLI run cancelled',
        exitCode: code,
        resultLen,
        assistantLen,
      };
    }

    if (code !== 0 && !text) {
      const errTail = stderr.trim().slice(-500);
      return {
        success: false,
        text: '',
        error: errTail || `CLI exited with code ${code}`,
        exitCode: code,
        resultLen,
        assistantLen,
      };
    }

    return {
      success: true,
      text: text || '(no output)',
      exitCode: code,
      resultLen,
      assistantLen,
    };
  }

  /** Cancel one chat's run, or all if chatId omitted. */
  cancel(chatId?: string): void {
    if (chatId) {
      this.killChild(this.children.get(chatId));
      return;
    }
    for (const child of this.children.values()) {
      this.killChild(child);
    }
  }

  private killChild(child: ChildProcess | undefined): void {
    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000).unref?.();
    } catch {
      // ignore
    }
  }

  isRunning(chatId?: string): boolean {
    if (chatId) {
      const child = this.children.get(chatId);
      return child != null && !child.killed;
    }
    for (const child of this.children.values()) {
      if (!child.killed) return true;
    }
    return false;
  }

  listRunningChatIds(): string[] {
    return [...this.children.keys()].filter((id) => {
      const c = this.children.get(id);
      return c != null && !c.killed;
    });
  }

  get runningCount(): number {
    return this.listRunningChatIds().length;
  }
}

/** Extract text deltas / final result from Cursor CLI stream-json lines. */
export function parseStreamJsonLine(
  line: string
): { delta?: string; result?: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = msg.type;
  if (type === 'assistant') {
    const message = msg.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const parts = message?.content;
    if (!Array.isArray(parts)) return null;
    let delta = '';
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        delta += part.text;
      }
    }
    return delta ? { delta } : null;
  }

  if (type === 'result') {
    if (typeof msg.result === 'string') return { result: msg.result };
    if (typeof msg.text === 'string') return { result: msg.text };
  }

  return null;
}
