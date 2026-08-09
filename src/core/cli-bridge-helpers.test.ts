/**
 * Tests for CLI lock, attach store, and job queue
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { tryAcquireCliChatLock, releaseCliChatLock } from './cli-chat-lock.js';
import {
  loadCliAttaches,
  saveCliAttaches,
  pruneInvalidCliAttaches,
} from './cli-attach-store.js';
import { CliJobQueue } from './cli-job-queue.js';

describe('CliJobQueue', () => {
  it('runs jobs serially in enqueue order', async () => {
    const q = new CliJobQueue<string>();
    const seen: string[] = [];
    let resolveGate: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });

    q.setProcessor('t1', async (job) => {
      if (job.payload === 'a') {
        seen.push('a-start');
        await gate;
        seen.push('a-end');
      } else {
        seen.push(job.payload);
      }
    });

    q.enqueue('t1', 'a');
    q.enqueue('t1', 'b');
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['a-start']);
    resolveGate!();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['a-start', 'a-end', 'b']);
  });

  it('clear removes pending jobs', () => {
    const q = new CliJobQueue<string>();
    q.setProcessor('t1', async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    q.enqueue('t1', 'a');
    q.enqueue('t1', 'b');
    q.enqueue('t1', 'c');
    // a may already be running; clear pending
    const cleared = q.clear('t1');
    expect(cleared).toBeGreaterThanOrEqual(1);
  });
});

describe('cli attach store', () => {
  it('round-trips attaches via save/load with project data dir', () => {
    // Uses real ~/cursor-cp/data — write a unique key and clean up
    const key = `test-${Date.now()}`;
    const map = loadCliAttaches();
    map.set(key, { chatId: 'uuid-1', cwd: '/tmp', title: 'T' });
    saveCliAttaches(map);
    const loaded = loadCliAttaches();
    expect(loaded.get(key)).toEqual({
      chatId: 'uuid-1',
      cwd: '/tmp',
      title: 'T',
      mode: 'agent',
    });
    loaded.delete(key);
    saveCliAttaches(loaded);
  });

  it('round-trips plan mode', () => {
    const key = `test-mode-${Date.now()}`;
    const map = loadCliAttaches();
    map.set(key, { chatId: 'uuid-2', cwd: '/tmp', title: 'P', mode: 'plan' });
    saveCliAttaches(map);
    const loaded = loadCliAttaches();
    expect(loaded.get(key)?.mode).toBe('plan');
    loaded.delete(key);
    saveCliAttaches(loaded);
  });

  it('prunes missing chat metas', () => {
    const map = new Map([
      ['1', { chatId: 'alive', cwd: '/a', title: 'A', mode: 'agent' as const }],
      ['2', { chatId: 'dead', cwd: '/b', title: 'B', mode: 'ask' as const }],
    ]);
    const removed = pruneInvalidCliAttaches(map, '/chats', (_root, id) => id === 'alive');
    expect(removed).toBe(1);
    expect(map.has('1')).toBe(true);
    expect(map.has('2')).toBe(false);
  });
});

describe('cli chat lock', () => {
  it('acquires and releases', () => {
    const id = `lock-test-${Date.now()}`;
    expect(tryAcquireCliChatLock(id).ok).toBe(true);
    expect(tryAcquireCliChatLock(id).ok).toBe(true); // same pid
    releaseCliChatLock(id);
  });
});
