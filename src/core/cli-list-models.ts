/**
 * List models available to Cursor CLI (`agent --list-models`).
 */

import { spawn } from 'node:child_process';
import { logger } from '../util/logger.js';

export interface CliListedModel {
  id: string;
  name: string;
}

/**
 * Parse `agent --list-models` / `agent models` text output.
 * Lines look like: `auto - Auto (current, default)` or `composer-2.5 - Composer 2.5`
 */
export function parseCliModelsOutput(text: string): CliListedModel[] {
  const models: CliListedModel[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models$/i.test(trimmed)) continue;
    // Ids contain hyphens (composer-2.5); split on first " - "
    const sep = trimmed.indexOf(' - ');
    if (sep <= 0) continue;
    const id = trimmed.slice(0, sep).trim();
    let name = trimmed.slice(sep + 3).trim();
    if (!id || /\s/.test(id)) continue;
    // Strip trailing status notes: "Auto (current, default)" → "Auto"
    name = name.replace(/\s*\([^)]*\)\s*$/, '').trim() || id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return models;
}

/** Map SDK Auto id to CLI id when falling back to SDK lists. */
export function mapSdkModelIdForCli(id: string): string {
  const trimmed = id.trim();
  if (/^default$/i.test(trimmed)) return 'auto';
  return trimmed;
}

export async function listCliModels(options: {
  agentBin: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<CliListedModel[]> {
  const env = { ...process.env };
  if (options.apiKey) env.CURSOR_API_KEY = options.apiKey;

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.agentBin, ['--list-models'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('agent --list-models timed out'));
    }, options.timeoutMs ?? 30_000);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) {
        resolve(out || err);
        return;
      }
      reject(new Error(err.trim() || `agent --list-models exited with code ${code}`));
    });
  });

  const models = parseCliModelsOutput(stdout);
  if (models.length === 0) {
    logger.warn({ sample: stdout.slice(0, 200) }, 'agent --list-models returned no parseable models');
  }
  return models;
}
