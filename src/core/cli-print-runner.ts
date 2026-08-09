/**
 * Run Cursor CLI headless (`agent -p --resume`) and collect assistant text.
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
  timeoutMs?: number;
  apiKey?: string;
  onChunk?: (text: string) => void;
}

export interface CliPrintRunResult {
  success: boolean;
  text: string;
  error?: string;
  exitCode: number | null;
}

export class CliPrintRunner {
  private active: ChildProcess | null = null;

  async run(options: CliPrintRunOptions): Promise<CliPrintRunResult> {
    if (this.active) {
      return {
        success: false,
        text: '',
        error: 'A CLI run is already in progress',
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
    this.active = child;

    let assistantText = '';
    let resultText = '';
    let stderr = '';
    const timeoutMs = options.timeoutMs ?? 600_000;

    if (!child.stdout || !child.stderr) {
      this.active = null;
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
    const timer = setTimeout(() => {
      timedOut = true;
      this.cancel();
    }, timeoutMs);

    const { code, signal } = await exitPromise;
    clearTimeout(timer);
    rl.close();
    this.active = null;

    const text = (resultText || assistantText).trim();
    if (timedOut) {
      return {
        success: false,
        text,
        error: `CLI run timed out after ${timeoutMs}ms`,
        exitCode: code,
      };
    }

    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      return {
        success: false,
        text,
        error: 'CLI run cancelled',
        exitCode: code,
      };
    }

    if (code !== 0 && !text) {
      const errTail = stderr.trim().slice(-500);
      return {
        success: false,
        text: '',
        error: errTail || `CLI exited with code ${code}`,
        exitCode: code,
      };
    }

    return {
      success: true,
      text: text || '(no output)',
      exitCode: code,
    };
  }

  cancel(): void {
    const child = this.active;
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

  get isRunning(): boolean {
    return this.active != null && !this.active.killed;
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
