/**
 * Best-effort advisory lock for Cursor CLI chat IDs (cursor-cp only).
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { dataDir, ensureProjectDirs } from '../paths.js';

export interface CliLockInfo {
  pid: number;
  chatId: string;
  acquiredAt: string;
}

function locksDir(): string {
  return resolve(dataDir(), 'cli-locks');
}

function lockPath(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return resolve(locksDir(), `${safe}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryAcquireCliChatLock(chatId: string): { ok: true } | { ok: false; holder: CliLockInfo } {
  ensureProjectDirs();
  mkdirSync(locksDir(), { recursive: true });
  const path = lockPath(chatId);

  if (existsSync(path)) {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf-8')) as CliLockInfo;
      if (holder.pid === process.pid) {
        return { ok: true };
      }
      if (isPidAlive(holder.pid)) {
        return { ok: false, holder };
      }
      // Stale lock — steal
      unlinkSync(path);
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  }

  const info: CliLockInfo = {
    pid: process.pid,
    chatId,
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(info), { encoding: 'utf-8', mode: 0o600 });
  return { ok: true };
}

export function releaseCliChatLock(chatId: string): void {
  const path = lockPath(chatId);
  if (!existsSync(path)) return;
  try {
    const holder = JSON.parse(readFileSync(path, 'utf-8')) as CliLockInfo;
    if (holder.pid !== process.pid) return;
  } catch {
    // still try remove if ours
  }
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}
