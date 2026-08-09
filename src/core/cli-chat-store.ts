/**
 * Read-only listing of Cursor CLI chats under ~/.cursor/chats.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { expandHome } from '../config/home.js';

export interface CliChatMeta {
  chatId: string;
  cwd: string;
  title: string;
  updatedAtMs: number;
  createdAtMs: number;
  hasConversation: boolean;
  projectHash: string;
  metaPath: string;
}

export interface ListCliChatsOptions {
  /** Root directory (default ~/.cursor/chats). Supports ~ expansion. */
  chatsRoot: string;
  /** If set, only include chats whose cwd is under this path. */
  cwdPrefix?: string;
  /** Max chats to return after sort (default 30). */
  limit?: number;
  /** Include chats with hasConversation: false (default false). */
  includeEmpty?: boolean;
}

interface RawMeta {
  schemaVersion?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  hasConversation?: boolean;
  title?: string;
  cwd?: string;
}

function isUnderPrefix(cwd: string, prefix: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedPrefix = resolve(prefix);
  return resolvedCwd === resolvedPrefix || resolvedCwd.startsWith(resolvedPrefix + '/');
}

export async function listCliChats(options: ListCliChatsOptions): Promise<CliChatMeta[]> {
  const root = expandHome(options.chatsRoot);
  const limit = options.limit ?? 30;
  const includeEmpty = options.includeEmpty ?? false;
  const cwdPrefix = options.cwdPrefix ? expandHome(options.cwdPrefix) : undefined;

  if (!existsSync(root)) {
    return [];
  }

  const byChatId = new Map<string, CliChatMeta>();

  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }

  for (const projectHash of projectDirs) {
    const projectPath = join(root, projectHash);
    let projectStat;
    try {
      projectStat = await stat(projectPath);
    } catch {
      continue;
    }
    if (!projectStat.isDirectory()) continue;

    let chatDirs: string[];
    try {
      chatDirs = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const chatId of chatDirs) {
      const metaPath = join(projectPath, chatId, 'meta.json');
      if (!existsSync(metaPath)) continue;

      let raw: RawMeta;
      try {
        raw = JSON.parse(await readFile(metaPath, 'utf-8')) as RawMeta;
      } catch {
        continue;
      }

      const hasConversation = Boolean(raw.hasConversation);
      if (!includeEmpty && !hasConversation) continue;

      const cwd = typeof raw.cwd === 'string' ? raw.cwd : '';
      if (!cwd) continue;
      if (cwdPrefix && !isUnderPrefix(cwd, cwdPrefix)) continue;

      const updatedAtMs = typeof raw.updatedAtMs === 'number' ? raw.updatedAtMs : 0;
      const createdAtMs = typeof raw.createdAtMs === 'number' ? raw.createdAtMs : updatedAtMs;
      const title =
        typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : '(untitled)';

      const entry: CliChatMeta = {
        chatId,
        cwd,
        title,
        updatedAtMs,
        createdAtMs,
        hasConversation,
        projectHash,
        metaPath,
      };

      const existing = byChatId.get(chatId);
      if (!existing || entry.updatedAtMs >= existing.updatedAtMs) {
        byChatId.set(chatId, entry);
      }
    }
  }

  return [...byChatId.values()]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, limit);
}

export function formatCliChatLabel(chat: CliChatMeta, maxLen = 60): string {
  const cwdTail = chat.cwd.split(/[/\\]/).filter(Boolean).pop() || chat.cwd;
  const label = `${chat.title} · ${cwdTail}`;
  return label.length <= maxLen ? label : label.slice(0, maxLen - 1) + '…';
}

/** True if any project hash under chatsRoot contains meta.json for chatId. */
export function cliChatMetaExists(chatsRoot: string, chatId: string): boolean {
  const root = expandHome(chatsRoot);
  if (!existsSync(root)) return false;
  try {
    const projects = readdirSync(root);
    for (const projectHash of projects) {
      const metaPath = join(root, projectHash, chatId, 'meta.json');
      if (existsSync(metaPath)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
