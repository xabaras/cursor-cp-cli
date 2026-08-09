/**
 * Tests for CLI chat store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { listCliChats, formatCliChatLabel } from './cli-chat-store.js';

describe('listCliChats', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'cli-chats-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMeta(
    projectHash: string,
    chatId: string,
    meta: Record<string, unknown>
  ): void {
    const dir = join(root, projectHash, chatId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  }

  it('returns empty list when root missing', async () => {
    const chats = await listCliChats({ chatsRoot: join(root, 'missing') });
    expect(chats).toEqual([]);
  });

  it('lists chats with conversation sorted by updatedAtMs', async () => {
    writeMeta('proj1', 'aaa-111', {
      hasConversation: true,
      title: 'Older',
      cwd: '/Users/me/proj',
      updatedAtMs: 100,
      createdAtMs: 50,
    });
    writeMeta('proj1', 'bbb-222', {
      hasConversation: true,
      title: 'Newer',
      cwd: '/Users/me/other',
      updatedAtMs: 200,
      createdAtMs: 150,
    });
    writeMeta('proj1', 'ccc-333', {
      hasConversation: false,
      title: 'Empty',
      cwd: '/Users/me/proj',
      updatedAtMs: 300,
    });

    const chats = await listCliChats({ chatsRoot: root });
    expect(chats).toHaveLength(2);
    expect(chats[0].chatId).toBe('bbb-222');
    expect(chats[0].title).toBe('Newer');
    expect(chats[1].chatId).toBe('aaa-111');
  });

  it('filters by cwdPrefix', async () => {
    writeMeta('p', 'one', {
      hasConversation: true,
      title: 'In Lavoro',
      cwd: '/Users/me/Sviluppo/Lavoro/App',
      updatedAtMs: 10,
    });
    writeMeta('p', 'two', {
      hasConversation: true,
      title: 'Elsewhere',
      cwd: '/Users/me/Other',
      updatedAtMs: 20,
    });

    const chats = await listCliChats({
      chatsRoot: root,
      cwdPrefix: '/Users/me/Sviluppo/Lavoro',
    });
    expect(chats).toHaveLength(1);
    expect(chats[0].chatId).toBe('one');
  });

  it('deduplicates chatId keeping newest', async () => {
    writeMeta('hash-a', 'same-id', {
      hasConversation: true,
      title: 'Old copy',
      cwd: '/Users/me/a',
      updatedAtMs: 10,
    });
    writeMeta('hash-b', 'same-id', {
      hasConversation: true,
      title: 'New copy',
      cwd: '/Users/me/b',
      updatedAtMs: 99,
    });

    const chats = await listCliChats({ chatsRoot: root });
    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe('New copy');
    expect(chats[0].cwd).toBe('/Users/me/b');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      writeMeta('p', `id-${i}`, {
        hasConversation: true,
        title: `T${i}`,
        cwd: `/Users/me/p${i}`,
        updatedAtMs: i,
      });
    }
    const chats = await listCliChats({ chatsRoot: root, limit: 2 });
    expect(chats).toHaveLength(2);
    expect(chats[0].chatId).toBe('id-4');
  });
});

describe('formatCliChatLabel', () => {
  it('includes title and cwd basename', () => {
    const label = formatCliChatLabel({
      chatId: 'x',
      cwd: '/Users/me/Sviluppo/Lavoro/MyFoodMate',
      title: 'Map Pin Bug',
      updatedAtMs: 1,
      createdAtMs: 1,
      hasConversation: true,
      projectHash: 'h',
      metaPath: '/tmp/meta.json',
    });
    expect(label).toContain('Map Pin Bug');
    expect(label).toContain('MyFoodMate');
  });
});
