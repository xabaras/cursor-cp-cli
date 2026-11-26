/**
 * Persist Telegram ↔ CLI chat attaches across daemon restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { dataDir, ensureProjectDirs } from '../paths.js';
import { logger } from '../util/logger.js';

/** Cursor CLI execution mode for `agent -p` (`agent` = default, no --mode flag). */
export type CliAgentMode = 'agent' | 'plan' | 'ask';

export function normalizeCliAgentMode(value: unknown): CliAgentMode {
  if (value === 'plan' || value === 'ask' || value === 'agent') return value;
  return 'agent';
}

export interface PersistedCliAttach {
  chatId: string;
  cwd: string;
  title: string;
  /** Default agent when omitted (legacy attaches). */
  mode?: CliAgentMode;
  /**
   * Cursor CLI model id for `agent -p --model` (e.g. `auto`, `composer-2.5`).
   * Omitted / empty = legacy unset (treated as Auto for display; no --model flag).
   * SDK Auto id `default` is normalized to CLI `auto`.
   */
  model?: string;
}

/** Normalize persisted model id; keeps `auto`; maps SDK `default` → `auto`. */
export function normalizeCliModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^default$/i.test(trimmed)) return 'auto';
  return trimmed;
}

/** Display label for status / replies. */
export function formatCliModelLabel(model: string | undefined): string {
  if (!model || /^auto$/i.test(model)) return 'Auto';
  return model;
}

function storePath(): string {
  return resolve(dataDir(), 'telegram-cli-attach.json');
}

export function loadCliAttaches(): Map<string, PersistedCliAttach> {
  ensureProjectDirs();
  const path = storePath();
  const map = new Map<string, PersistedCliAttach>();
  if (!existsSync(path)) return map;

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, PersistedCliAttach>;
    for (const [telegramChatId, attach] of Object.entries(raw)) {
      if (!attach?.chatId || !attach?.cwd) continue;
      const model = normalizeCliModel(attach.model);
      map.set(telegramChatId, {
        chatId: attach.chatId,
        cwd: attach.cwd,
        title: attach.title || '(untitled)',
        mode: normalizeCliAgentMode(attach.mode),
        ...(model ? { model } : {}),
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load telegram-cli-attach.json');
  }
  return map;
}

export function saveCliAttaches(attaches: Map<string, PersistedCliAttach>): void {
  ensureProjectDirs();
  mkdirSync(dataDir(), { recursive: true });
  const obj: Record<string, PersistedCliAttach> = {};
  for (const [telegramChatId, attach] of attaches.entries()) {
    obj[telegramChatId] = attach;
  }
  writeFileSync(storePath(), JSON.stringify(obj, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Drop attaches whose CLI meta.json no longer exists. */
export function pruneInvalidCliAttaches(
  attaches: Map<string, PersistedCliAttach>,
  chatsRoot: string,
  metaExists: (chatsRoot: string, chatId: string) => boolean
): number {
  let removed = 0;
  for (const [key, attach] of [...attaches.entries()]) {
    if (!metaExists(chatsRoot, attach.chatId)) {
      attaches.delete(key);
      removed += 1;
    }
  }
  return removed;
}
