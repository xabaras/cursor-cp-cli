/**
 * Tests for CLI chat store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { listCliChats, formatCliChatLabel, isTempDirCwd } from './cli-chat-store.js';

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

  it('returns every chat with no limit', async () => {
    for (let i = 0; i < 40; i++) {
      writeMeta('p', `id-${i}`, {
        hasConversation: true,
        title: `T${i}`,
        cwd: `/Users/me/p${i}`,
        updatedAtMs: i,
      });
    }
    expect(await listCliChats({ chatsRoot: root, limit: Infinity })).toHaveLength(40);
  });

  it('hides chats run in a temp dir unless asked', async () => {
    writeMeta('p', 'real', { hasConversation: true, cwd: '/Users/me/app', updatedAtMs: 1 });
    writeMeta('p', 'formatter', {
      hasConversation: true,
      cwd: '/private/var/folders/9n/abc/T/tmp.N5fka7jEdZ',
      updatedAtMs: 2,
    });
    writeMeta('p', 'mktemp', { hasConversation: true, cwd: join(tmpdir(), 'tmp.x'), updatedAtMs: 3 });
    writeMeta('p', 'slash-tmp', { hasConversation: true, cwd: '/tmp/run', updatedAtMs: 4 });

    const shown = await listCliChats({ chatsRoot: root });
    expect(shown.map((c) => c.chatId)).toEqual(['real']);

    const all = await listCliChats({ chatsRoot: root, excludeTempDirs: false });
    expect(all).toHaveLength(4);
  });
});

describe('isTempDirCwd', () => {
  it('matches temp roots and their children only', () => {
    const roots = ['/tmp', '/private/var/folders'];
    expect(isTempDirCwd('/tmp', roots)).toBe(true);
    expect(isTempDirCwd('/private/var/folders/9n/x/T/tmp.1', roots)).toBe(true);
    expect(isTempDirCwd('/tmpfiles/app', roots)).toBe(false);
    expect(isTempDirCwd('/Users/me/tmp', roots)).toBe(false);
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
