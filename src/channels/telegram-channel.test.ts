/**
 * Tests for TelegramChannel exports
 *
 * Note: Full integration tests for TelegramChannel are covered by E2E tests.
 * Testing the Telegraf bot requires complex mocking that's better handled
 * at the integration level.
 */

import { describe, it, expect } from 'vitest';

describe('TelegramChannel', () => {
  it('should export TelegramChannel class', async () => {
    const { TelegramChannel } = await import('./telegram-channel.js');
    expect(TelegramChannel).toBeDefined();
    expect(typeof TelegramChannel).toBe('function');
  });

  it('should have required methods on prototype', async () => {
    const { TelegramChannel } = await import('./telegram-channel.js');
    expect(typeof TelegramChannel.prototype.start).toBe('function');
    expect(typeof TelegramChannel.prototype.stop).toBe('function');
    expect(typeof TelegramChannel.prototype.sendMessage).toBe('function');
    expect(typeof TelegramChannel.prototype.askQuestion).toBe('function');
  });
});

describe('CALLBACK_PATTERNS', () => {
  type Route = 'session' | 'model' | 'cliModel' | 'gh' | 'ws' | 'cli';
  const routes: Route[] = ['session', 'model', 'cliModel', 'gh', 'ws', 'cli'];

  async function matching(data: string): Promise<Route[]> {
    const { CALLBACK_PATTERNS } = await import('./telegram-channel.js');
    return routes.filter((r) => CALLBACK_PATTERNS[r].test(data));
  }

  it('routes /cli new workspace picks to the cli handler only', async () => {
    // /ws:(\d+)/ used to match the "ws:3" inside it and answer Invalid selection.
    expect(await matching('cli:newws:3')).toEqual(['cli']);
  });

  it('keeps every cli: callback away from the SDK handlers', async () => {
    for (const data of ['cli:cwd:2', 'cli:3', 'cli:off', 'cli:page:2', 'cli:sw:85593dea-25de']) {
      expect(await matching(data)).toEqual(['cli']);
    }
    expect(await matching('cli:model:1')).toEqual(['cliModel', 'cli']);
  });

  it('still routes the SDK callbacks', async () => {
    expect(await matching('ws:3')).toEqual(['ws']);
    expect(await matching('gh:0')).toEqual(['gh']);
    expect(await matching('model:4')).toEqual(['model']);
    expect(await matching('session:abc')).toEqual(['session']);
  });

  it('anchors question tokens', async () => {
    const { CALLBACK_PATTERNS } = await import('./telegram-channel.js');
    const q = CALLBACK_PATTERNS.question('abc123');
    expect(q.test('q:abc123:1')).toBe(true);
    expect(q.test('xq:abc123:1')).toBe(false);
    expect(q.test('q:abc123:1:extra')).toBe(false);
  });
});

describe('buildCliChatPage', () => {
  const chats = Array.from({ length: 64 }, (_, i) => ({
    chatId: `id-${i}`,
    cwd: `/Users/me/p${i}`,
    title: `Chat ${i}`,
    updatedAtMs: 1000 - i,
    createdAtMs: 0,
    hasConversation: true,
    projectHash: 'h',
    metaPath: `/x/${i}/meta.json`,
  }));

  type Button = { text: string; callback_data: string };
  const data = (rows: unknown[][]) => rows.flat().map((b) => (b as Button).callback_data);

  it('splits 64 chats into 4 pages with global indexes', async () => {
    const { buildCliChatPage } = await import('./telegram-channel.js');
    const first = buildCliChatPage(chats, 0, 'Pick:');
    expect(first.pages).toBe(4);
    expect(first.text).toContain('Page 1/4 · 64 chats');
    expect(data(first.buttons)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `cli:${i}`),
      'cli:page:1',
      'cli:off',
    ]);

    const second = buildCliChatPage(chats, 1, 'Pick:');
    expect(data(second.buttons).slice(0, 2)).toEqual(['cli:20', 'cli:21']);
    expect(data(second.buttons)).toContain('cli:page:0');
    expect(data(second.buttons)).toContain('cli:page:2');

    const last = buildCliChatPage(chats, 3, 'Pick:');
    expect(data(last.buttons)).toEqual([
      'cli:60',
      'cli:61',
      'cli:62',
      'cli:63',
      'cli:page:2',
      'cli:off',
    ]);
  });

  it('clamps out-of-range pages', async () => {
    const { buildCliChatPage } = await import('./telegram-channel.js');
    expect(buildCliChatPage(chats, 99, 'Pick:').page).toBe(3);
    expect(buildCliChatPage(chats, -1, 'Pick:').page).toBe(0);
  });

  it('shows a single page without navigation or counter', async () => {
    const { buildCliChatPage } = await import('./telegram-channel.js');
    const one = buildCliChatPage(chats.slice(0, 3), 0, 'Pick:');
    expect(one.text).toBe('Pick:');
    expect(data(one.buttons)).toEqual(['cli:0', 'cli:1', 'cli:2', 'cli:off']);
  });
});
