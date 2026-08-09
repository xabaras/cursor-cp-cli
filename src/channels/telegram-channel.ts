/**
 * Telegram Bot Channel using Telegraf
 */

import { Telegraf, Markup, Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { Channel } from './base.js';
import type { MessageTarget, AppConfig } from '../models/types.js';
import type { SessionManager } from '../core/session-manager.js';
import { listLocalWorkspaceItems } from '../core/repo-picker.js';
import {
  listCliChats,
  formatCliChatLabel,
  cliChatMetaExists,
  type CliChatMeta,
} from '../core/cli-chat-store.js';
import { CliPrintRunner } from '../core/cli-print-runner.js';
import { tryAcquireCliChatLock, releaseCliChatLock } from '../core/cli-chat-lock.js';
import {
  loadCliAttaches,
  saveCliAttaches,
  pruneInvalidCliAttaches,
  normalizeCliAgentMode,
  type CliAgentMode,
} from '../core/cli-attach-store.js';
import { CliJobQueue } from '../core/cli-job-queue.js';
import { createCliChat } from '../core/cli-create-chat.js';
import { splitPlainText, markdownToTelegram, markdownToTelegramHtml } from '../format/telegram-format.js';
import { createHash } from 'crypto';
import { logger } from '../util/logger.js';
import { getVersion, APP_DISPLAY_NAME } from '../cli/help.js';
import {
  TELEGRAM_HANDLER_TIMEOUT_MS,
  wrapTelegramHandler,
  formatTelegramError,
  replySafe,
} from './telegram-resilience.js';

interface PendingQuestion {
  resolve: (answer: string) => void;
  options: string[];
  sessionId: string;
}

interface CliAttach {
  chatId: string;
  cwd: string;
  title: string;
  mode: CliAgentMode;
}

interface CliJobPayload {
  telegramChatId: string;
  attach: CliAttach;
  text: string;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private bot: Telegraf<Context<Update>>;
  private sessionManager: SessionManager;
  private allowedUserIds: Set<number>;
  private config: AppConfig;

  // Pending questions by callback token
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  // GitHub repo selection pending
  private pendingGitHubRepos: Map<string, string[]> = new Map();
  // Workspace selection pending
  private pendingWorkspaces: Map<string, string[]> = new Map();
  // Model IDs for callbacks
  private modelIds: Map<string, string[]> = new Map();
  // Pending CLI chat picks for /cli
  private pendingCliChats: Map<string, CliChatMeta[]> = new Map();
  // Pending workspaces for /cli new
  private pendingCliNewWorkspaces: Map<string, string[]> = new Map();
  // Active CLI attach per Telegram chat (overrides SDK routing for text)
  private cliAttaches: Map<string, CliAttach> = new Map();
  private cliRunner = new CliPrintRunner();
  private cliQueue = new CliJobQueue<CliJobPayload>();

  // Track active sessions per chat
  private activeSessions: Map<string, string> = new Map();

  constructor(
    token: string,
    sessionManager: SessionManager,
    allowedUserIds: Set<number>,
    config: AppConfig
  ) {
    this.bot = new Telegraf(token, { handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS });
    this.sessionManager = sessionManager;
    this.allowedUserIds = allowedUserIds;
    this.config = config;

    this.restoreCliAttaches();
    this.setupHandlers();
    this.setupMiddleware();
  }

  private restoreCliAttaches(): void {
    if (!this.config.cliBridge.enabled) return;
    const loaded = loadCliAttaches();
    const removed = pruneInvalidCliAttaches(
      loaded,
      this.config.cliBridge.chatsRoot,
      cliChatMetaExists
    );
    this.cliAttaches = new Map();
    for (const [key, attach] of loaded.entries()) {
      this.cliAttaches.set(key, {
        chatId: attach.chatId,
        cwd: attach.cwd,
        title: attach.title,
        mode: normalizeCliAgentMode(attach.mode),
      });
    }
    if (removed > 0) {
      this.persistCliAttaches();
      logger.info({ removed }, 'Pruned stale CLI attaches');
    } else if (loaded.size > 0) {
      logger.info({ count: loaded.size }, 'Restored CLI attaches from disk');
    }
  }

  private persistCliAttaches(): void {
    try {
      saveCliAttaches(this.cliAttaches);
    } catch (err) {
      logger.warn({ err }, 'Failed to persist CLI attaches');
    }
  }

  private setCliAttach(telegramChatId: string, attach: CliAttach): void {
    this.cliAttaches.set(telegramChatId, {
      ...attach,
      mode: normalizeCliAgentMode(attach.mode),
    });
    this.activeSessions.delete(telegramChatId);
    this.persistCliAttaches();
  }

  private setCliMode(telegramChatId: string, mode: CliAgentMode): boolean {
    const attach = this.cliAttaches.get(telegramChatId);
    if (!attach) return false;
    attach.mode = mode;
    this.persistCliAttaches();
    return true;
  }

  private clearCliAttach(telegramChatId: string): void {
    this.cliAttaches.delete(telegramChatId);
    this.persistCliAttaches();
  }

  private setupMiddleware(): void {
    // Allowlist middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.allowedUserIds.has(userId)) {
        logger.warn(
          { userId, username: ctx.from?.username, updateType: ctx.updateType },
          'Telegram access denied'
        );
        return;
      }
      return next();
    });
  }

  private botCommands(): Array<{ command: string; description: string }> {
    const commands = [
      { command: 'start', description: 'Show help' },
      { command: 'sessions', description: 'List sessions and connect' },
      { command: 'models', description: 'List models and set default' },
      { command: 'current', description: 'Show current session' },
      { command: 'close', description: 'Close current session' },
      { command: 'closeall', description: 'Close all sessions' },
      { command: 'repos', description: 'GitHub repos (gh)' },
      { command: 'workspaces', description: 'Local workspace folders' },
      { command: 'version', description: `Show ${APP_DISPLAY_NAME} version` },
    ];
    if (this.config.cliBridge.enabled) {
      commands.splice(2, 0, {
        command: 'cli',
        description: 'CLI chats: list/mode/new/cancel/off (see /start)',
      });
    }
    return commands;
  }

  /** Register slash commands for allowed users (Telegram autocomplete menu). */
  private async syncBotCommands(): Promise<void> {
    try {
      await this.bot.telegram.deleteMyCommands();
    } catch (err) {
      logger.warn({ err }, 'Could not clear default Telegram command list');
    }

    if (this.allowedUserIds.size === 0) {
      logger.warn(
        'Telegram is enabled but TELEGRAM_ALLOWED_USER_IDS is empty — slash commands will not appear'
      );
      return;
    }

    for (const userId of this.allowedUserIds) {
      await this.syncBotCommandsForUser(userId);
    }
  }

  private async syncBotCommandsForUser(userId: number): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(this.botCommands(), {
        scope: { type: 'chat', chat_id: userId },
      });
      logger.info({ userId }, 'Telegram slash commands registered');
    } catch (err) {
      logger.warn(
        { err, userId },
        'Could not set Telegram commands for user (send /start to the bot first)'
      );
    }
  }

  private setupHandlers(): void {
    // Start command
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id;
      if (userId) {
        await this.syncBotCommandsForUser(userId);
      }

      // Plain text: Telegram legacy Markdown breaks on backticks/tildes in paths like ~/.cursor/chats
      await ctx.reply(
        [
          APP_DISPLAY_NAME,
          '',
          'Available commands:',
          '/sessions - List and connect to SDK sessions',
          '/models - List models and set default',
          '/repos - Browse GitHub repositories',
          '/workspaces - Browse local workspaces',
          '/current - Show current session or CLI attach',
          '/close - Close current SDK session',
          '/closeall - Close all SDK sessions',
          '/version - Show version',
          ...(this.config.cliBridge.enabled
            ? [
                '',
                'Cursor CLI bridge (existing agent chats on your machine):',
                '/cli - List and attach a CLI chat (filtered by workspace_root)',
                '/cli all - List all CLI chats',
                '/cli new - Create and attach a new CLI chat',
                '/cli mode [agent|plan|ask] - Show or set CLI execution mode',
                '/cli plan|/cli ask|/cli agent - Shortcuts for /cli mode',
                '/cli cancel - Stop the current CLI run',
                '/cli cancel all - Stop run and clear the queue',
                '/cli off - Detach CLI mode (back to SDK sessions)',
                '/cli status - Show CLI attach status',
                '',
                'With a CLI chat attached, plain text continues that chat',
                '(queued if busy; runs with --force, no tool approvals).',
                'plan/ask are read-only CLI modes; agent can edit (default).',
                'Without CLI attach, plain text uses SDK sessions.',
                'Avoid using the same CLI chat in the terminal and Telegram at once.',
              ]
            : [
                '',
                'Send any text to start or continue an SDK session.',
              ]),
        ].join('\n')
      );
    });

    // Version
    this.bot.command('version', async (ctx) => {
      await ctx.reply(`${APP_DISPLAY_NAME} v${getVersion()}`);
    });

    // Sessions list
    this.bot.command('sessions', async (ctx) => {
      const sessions = this.sessionManager.listAllSessions(false);

      if (sessions.length === 0) {
        await ctx.reply('No active sessions. Send me text to create one!');
        return;
      }

      const buttons = sessions.map((s) => {
        const status = s.status === 'open' ? '🟢' : '⚫';
        const model = s.model ? ` [${s.model}]` : '';
        const label = `${status} ${s.title || s.repoName}${model}`.slice(0, 60);
        return [Markup.button.callback(label, `session:${s.id}`)];
      });

      await ctx.reply('Active sessions — tap to connect:', Markup.inlineKeyboard(buttons));
    });

    // Models list
    this.bot.command('models', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const models = await this.sessionManager.getAgentService().listAvailableModels();

      if (models.length === 0) {
        await ctx.reply('No models available.');
        return;
      }

      const buttons = models.map((m, i) => {
        return [Markup.button.callback(m.name, `model:${i}`)];
      });

      this.modelIds.set(
        chatId,
        models.map((m) => m.id)
      );

      await ctx.reply(
        'Available models — tap to set as default:\n' +
        `(Current: ${this.sessionManager.getDefaultModel() || 'Auto'})`,
        Markup.inlineKeyboard(buttons)
      );
    });

    // Current session
    this.bot.command('current', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const cliAttach = this.cliAttaches.get(chatId);
      if (cliAttach) {
        await ctx.reply(
          `📎 *CLI chat*\n` +
            `Title: ${cliAttach.title}\n` +
            `Id: \`${cliAttach.chatId}\`\n` +
            `cwd: \`${cliAttach.cwd}\`\n` +
            `CLI mode: ${cliAttach.mode}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const sessionId = this.activeSessions.get(chatId);

      if (!sessionId) {
        await ctx.reply('No active session. Use /sessions or /cli.');
        return;
      }

      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        await ctx.reply('Session not found. It may have been closed.');
        return;
      }

      await ctx.reply(
        `📁 *${session.title || session.repoName}*\n` +
        `Status: ${session.status}\n` +
        `Activity: ${session.activity}\n` +
        `Model: ${session.model || 'Auto'}`,
        { parse_mode: 'Markdown' }
      );
    });

    // Close current session
    this.bot.command('close', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const sessionId = this.activeSessions.get(chatId);

      if (!sessionId) {
        await ctx.reply('No active session to close.');
        return;
      }

      await this.sessionManager.closeSession(sessionId);
      this.activeSessions.delete(chatId);
      await ctx.reply('✅ Session closed.');
    });

    // Close all sessions
    this.bot.command('closeall', async (ctx) => {
      const count = await this.sessionManager.closeAllSessions();
      this.activeSessions.clear();
      await ctx.reply(`✅ Closed ${count} session(s).`);
    });

    // GitHub repos
    this.bot.command('repos', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const { execa } = await import('execa');
        const { stdout } = await execa('gh', ['repo', 'list', '--limit', '20', '--json', 'nameWithOwner']);
        const repos = JSON.parse(stdout) as Array<{ nameWithOwner: string }>;

        if (repos.length === 0) {
          await ctx.reply('No GitHub repos found. Make sure `gh` is installed and authenticated.');
          return;
        }

        const owners = repos.map((r) => r.nameWithOwner);
        this.pendingGitHubRepos.set(chatId, owners);

        const buttons = owners.map((nwo, i) => {
          return [Markup.button.callback(nwo, `gh:${i}`)];
        });

        await ctx.reply('GitHub repos — tap to clone:', Markup.inlineKeyboard(buttons));
      } catch {
        await ctx.reply('Could not list GitHub repos. Is `gh` installed and logged in?');
      }
    });

    // Workspaces (same local folders as the web repo picker)
    this.bot.command('workspaces', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const items = await listLocalWorkspaceItems(this.config);

        if (items.length === 0) {
          await ctx.reply(
            `No workspace folders yet under:\n${this.config.workspaceRoot}\n\n` +
            'Clone a repo with /repos or add folders there.'
          );
          return;
        }

        const paths = items.map((item) => item.path);
        this.pendingWorkspaces.set(chatId, paths);

        const buttons = items.map((item, i) => {
          const name = item.path.split(/[/\\]/).pop() || item.label.replace(/^local-/, '');
          const label = name.slice(0, 60);
          return [Markup.button.callback(label, `ws:${i}`)];
        });

        await ctx.reply(
          `Local workspaces under ${this.config.workspaceRoot} — tap to use:`,
          Markup.inlineKeyboard(buttons)
        );
      } catch (err) {
        logger.error({ err, workspaceRoot: this.config.workspaceRoot }, 'Failed to list workspaces');
        await ctx.reply('Could not list workspaces.');
      }
    });

    // Cursor CLI chats (~/.cursor/chats) via agent -p --resume
    this.bot.command('cli', async (ctx) => {
      if (!this.config.cliBridge.enabled) {
        await ctx.reply(
          'CLI bridge is disabled. Set `cli_bridge.enabled: true` in config.yaml and restart.'
        );
        return;
      }

      const chatId = String(ctx.chat?.id);
      const message = ctx.message;
      const rawText =
        message && 'text' in message && typeof message.text === 'string' ? message.text : '/cli';
      const arg = rawText.replace(/^\/cli(@\w+)?/i, '').trim();
      const argLower = arg.toLowerCase();

      if (argLower === 'off' || argLower === 'detach' || argLower === 'clear') {
        if (!this.cliAttaches.has(chatId)) {
          await ctx.reply('No CLI chat attached.');
          return;
        }
        this.clearCliAttach(chatId);
        await ctx.reply('✅ Detached from CLI chat. Text now uses Control Plane SDK sessions.');
        return;
      }

      if (argLower === 'status' || argLower === 'current') {
        await this.replyCliStatus(ctx, chatId);
        return;
      }

      if (
        argLower === 'mode' ||
        argLower.startsWith('mode ') ||
        argLower === 'plan' ||
        argLower === 'ask' ||
        argLower === 'agent'
      ) {
        await this.handleCliModeCommand(ctx, chatId, argLower);
        return;
      }

      if (argLower === 'cancel' || argLower.startsWith('cancel ')) {
        const all = argLower === 'cancel all' || argLower.endsWith(' all');
        const wasRunning = this.cliRunner.isRunning;
        this.cliRunner.cancel();
        const cleared = all ? this.cliQueue.clear(chatId) : 0;
        if (!wasRunning && cleared === 0) {
          await ctx.reply('Nothing to cancel (no active CLI run / empty queue).');
          return;
        }
        await ctx.reply(
          all
            ? `✅ Cancelled run and cleared ${cleared} queued job(s).`
            : '✅ Cancel signal sent to current CLI run (queue kept).'
        );
        return;
      }

      if (argLower === 'new') {
        await this.startCliNew(ctx, chatId);
        return;
      }

      const listAll = argLower === 'all';
      await this.replyCliChatList(ctx, chatId, { listAll });
    });

    // Handle session selection callback
    this.bot.action(/session:(.+)/, async (ctx) => {
      const sessionId = ctx.match[1];
      const chatId = String(ctx.chat?.id);

      this.clearCliAttach(chatId);
      await this.sessionManager.joinSession(sessionId, 'telegram', chatId);
      this.activeSessions.set(chatId, sessionId);

      await ctx.answerCbQuery('Connected to session');
      await ctx.reply('✅ Connected to SDK session (CLI attach cleared). You can now send messages.');
    });

    // Handle model selection callback
    this.bot.action(/model:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const _chatId = String(ctx.chat?.id);
      const models = this.modelIds.get(_chatId);

      if (models) {
        const model = models[index];
        if (model) {
          this.sessionManager.setDefaultModel(model);
          await ctx.answerCbQuery(`Default model set to ${model}`);
          await ctx.reply(`✅ Default model set to: ${model}`);
        }
      }
    });

    // Handle GitHub repo selection
    this.bot.action(/gh:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const repos = this.pendingGitHubRepos.get(chatId);

      if (!repos || !repos[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const nwo = repos[index];
      await ctx.answerCbQuery(`Cloning ${nwo}...`);

      try {
        const { execa } = await import('execa');
        const { mkdir } = await import('fs/promises');
        const { resolve } = await import('path');

        const workspaceRoot = this.config.workspaceRoot;
        await mkdir(workspaceRoot, { recursive: true });

        const repoName = nwo.split('/')[1];
        const targetPath = resolve(workspaceRoot, repoName);

        // Check if already exists
        const { existsSync } = await import('fs');
        if (existsSync(targetPath)) {
          await ctx.reply(`📁 ${repoName} already exists. Using existing.`);
        } else {
          await execa('gh', ['repo', 'clone', nwo], { cwd: workspaceRoot });
          await ctx.reply(`✅ Cloned ${nwo}`);
        }

        // Create session with this repo
        this.clearCliAttach(chatId);
        const session = await this.sessionManager.createSession('telegram', chatId, targetPath, repoName);
        this.activeSessions.set(chatId, session.id);
        await ctx.reply(`✅ Created session for ${repoName}. Send me text to start!`);
      } catch (err) {
        await ctx.reply(`❌ Failed to clone: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Handle workspace selection
    this.bot.action(/ws:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const paths = this.pendingWorkspaces.get(chatId);

      if (!paths || !paths[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const path = paths[index];
      const name = path.split(/[/\\]/).pop() || 'workspace';

      this.clearCliAttach(chatId);
      await ctx.answerCbQuery(`Using workspace: ${name}`);

      const session = await this.sessionManager.createSession('telegram', chatId, path, name);
      this.activeSessions.set(chatId, session.id);
      await ctx.reply(`✅ Created session for ${name}. Send me text to start!`);
    });

    // Handle CLI chat selection / detach / new-workspace
    this.bot.action(/^cli:(.+)$/, async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const key = ctx.match[1];

      if (key === 'off') {
        this.clearCliAttach(chatId);
        await ctx.answerCbQuery('Detached');
        await ctx.reply('✅ Detached from CLI chat. Text now uses Control Plane SDK sessions.');
        return;
      }

      if (key.startsWith('newws:')) {
        const index = Number.parseInt(key.slice('newws:'.length), 10);
        const paths = this.pendingCliNewWorkspaces.get(chatId);
        if (!paths || Number.isNaN(index) || !paths[index]) {
          await ctx.answerCbQuery('Invalid selection');
          return;
        }
        await ctx.answerCbQuery('Creating CLI chat…');
        await this.createAndAttachCliChat(chatId, paths[index]);
        return;
      }

      const index = Number.parseInt(key, 10);
      const chats = this.pendingCliChats.get(chatId);
      if (!chats || Number.isNaN(index) || !chats[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const chat = chats[index];
      const prev = this.cliAttaches.get(chatId);
      this.setCliAttach(chatId, {
        chatId: chat.chatId,
        cwd: chat.cwd,
        title: chat.title,
        mode: prev?.mode ?? 'agent',
      });

      await ctx.answerCbQuery(`Attached: ${chat.title}`);
      await ctx.reply(
        `✅ Attached CLI chat *${chat.title}*\n` +
          `Id: \`${chat.chatId}\`\n` +
          `cwd: \`${chat.cwd}\`\n` +
          `CLI mode: ${prev?.mode ?? 'agent'}\n\n` +
          'Send text to continue this chat via `agent -p --resume`.\n' +
          'Note: runs with --force (no tool approval prompts). /cli mode plan|ask|agent · /cli off to detach.',
        { parse_mode: 'Markdown' }
      );
    });

    // Ack quickly; run agent work in background so Telegraf handlerTimeout is not hit.
    this.bot.on(
      'text',
      wrapTelegramHandler('text', async (ctx) => {
        const chatId = String(ctx.chat?.id);
        const message = ctx.message;
        if (!message || !('text' in message) || typeof message.text !== 'string') {
          return;
        }
        const text = message.text;

        if (text.startsWith('/')) return;

        logger.info({ chatId, textLength: text.length }, 'Telegram text message received');

        const cliAttach = this.cliAttaches.get(chatId);
        if (cliAttach && this.config.cliBridge.enabled) {
          await ctx.sendChatAction('typing');
          this.enqueueCliJob(chatId, cliAttach, text);
          return;
        }

        const sessionId = await this.resolveOrCreateSession(chatId, ctx);
        await ctx.sendChatAction('typing');
        await ctx.reply('⏳ Processing…');
        void this.processSessionMessage(sessionId, text, chatId);
      })
    );
  }

  private async replyCliStatus(ctx: Context<Update>, chatId: string): Promise<void> {
    const attach = this.cliAttaches.get(chatId);
    if (!attach) {
      await ctx.reply('Mode: SDK sessions (no CLI attach).\nUse /cli to attach a Cursor CLI chat.');
      return;
    }
    const pending = this.cliQueue.pendingCount(chatId);
    const running = this.cliQueue.isRunning(chatId) || this.cliRunner.isRunning;
    await ctx.reply(
      `Mode: *CLI attached*\n` +
        `Title: ${attach.title}\n` +
        `Id: \`${attach.chatId}\`\n` +
        `cwd: \`${attach.cwd}\`\n` +
        `CLI mode: ${attach.mode}\n` +
        `Run: ${running ? 'active' : 'idle'}` +
        (pending ? ` · queue: ${pending}` : '') +
        `\n\nTool approvals: none (--force). /cli mode plan|ask|agent · /cli off to detach.`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleCliModeCommand(
    ctx: Context<Update>,
    chatId: string,
    argLower: string
  ): Promise<void> {
    const attach = this.cliAttaches.get(chatId);
    if (!attach) {
      await ctx.reply('No CLI chat attached. Use /cli to attach one first.');
      return;
    }

    let next: string | undefined;
    if (argLower === 'plan' || argLower === 'ask' || argLower === 'agent') {
      next = argLower;
    } else if (argLower === 'mode') {
      next = undefined;
    } else if (argLower.startsWith('mode ')) {
      next = argLower.slice('mode '.length).trim();
    }

    if (!next) {
      await ctx.reply(
        [
          `CLI mode: ${attach.mode}`,
          '',
          'Usage:',
          '/cli mode agent — default (can edit; --force)',
          '/cli mode plan — read-only planning',
          '/cli mode ask — read-only Q&A',
          '',
          'Shortcuts: /cli plan | /cli ask | /cli agent',
          'Note: debug is not available via Cursor CLI headless.',
        ].join('\n')
      );
      return;
    }

    if (next !== 'agent' && next !== 'plan' && next !== 'ask') {
      await ctx.reply(
        `Unknown mode "${next}". Use agent, plan, or ask.\nCurrent: ${attach.mode}`
      );
      return;
    }

    this.setCliMode(chatId, next);
    const hint =
      next === 'agent'
        ? 'Next messages run in agent mode (edits allowed, --force).'
        : `Next messages run with --mode ${next} (read-only).`;
    await ctx.reply(`✅ CLI mode set to: ${next}\n${hint}`);
  }

  private async replyCliChatList(
    ctx: Context<Update>,
    chatId: string,
    options: { listAll: boolean }
  ): Promise<void> {
    try {
      const filter =
        !options.listAll && this.config.cliBridge.filterByWorkspaceRoot
          ? this.config.workspaceRoot
          : undefined;
      const chats = await listCliChats({
        chatsRoot: this.config.cliBridge.chatsRoot,
        cwdPrefix: filter,
        limit: 25,
      });

      if (chats.length === 0) {
        await ctx.reply(
          `No Cursor CLI chats found` +
            (filter ? ` under ${filter}` : '') +
            `.\nStore: ${this.config.cliBridge.chatsRoot}\n\n` +
            'Try `/cli all`, `/cli new`, or start a chat with `agent` in a terminal.'
        );
        return;
      }

      this.pendingCliChats.set(chatId, chats);
      const buttons = chats.map((chat, i) => {
        return [Markup.button.callback(formatCliChatLabel(chat), `cli:${i}`)];
      });
      buttons.push([Markup.button.callback('Detach CLI (/cli off)', 'cli:off')]);

      const attached = this.cliAttaches.get(chatId);
      const scope = filter ? `(filtered: ${filter})` : '(all chats)';
      const header = attached
        ? `Currently attached: ${attached.title}\n${scope}\n\nPick a Cursor CLI chat:`
        : `Cursor CLI chats ${scope} — tap to attach:`;

      await ctx.reply(header, Markup.inlineKeyboard(buttons));
    } catch (err) {
      logger.error({ err }, 'Failed to list CLI chats');
      await ctx.reply('Could not list CLI chats.');
    }
  }

  private async startCliNew(ctx: Context<Update>, chatId: string): Promise<void> {
    const existing = this.cliAttaches.get(chatId);
    if (existing?.cwd) {
      await ctx.reply(`Creating CLI chat in \`${existing.cwd}\`…`, { parse_mode: 'Markdown' });
      await this.createAndAttachCliChat(chatId, existing.cwd);
      return;
    }

    const sessionId = this.activeSessions.get(chatId);
    if (sessionId) {
      const session = this.sessionManager.getSession(sessionId);
      if (session?.repoPath) {
        await ctx.reply(`Creating CLI chat in \`${session.repoPath}\`…`, {
          parse_mode: 'Markdown',
        });
        await this.createAndAttachCliChat(chatId, session.repoPath);
        return;
      }
    }

    try {
      const items = await listLocalWorkspaceItems(this.config);
      if (items.length === 0) {
        await ctx.reply(
          `No workspaces under ${this.config.workspaceRoot}. Add a project folder or attach a CLI chat first.`
        );
        return;
      }
      const paths = items.map((i) => i.path);
      this.pendingCliNewWorkspaces.set(chatId, paths);
      const buttons = items.map((item, i) => {
        const name = item.path.split(/[/\\]/).pop() || item.label;
        return [Markup.button.callback(name.slice(0, 60), `cli:newws:${i}`)];
      });
      await ctx.reply(
        'Pick a workspace for the new CLI chat:',
        Markup.inlineKeyboard(buttons)
      );
    } catch (err) {
      logger.error({ err }, 'Failed to list workspaces for /cli new');
      await ctx.reply('Could not list workspaces for /cli new.');
    }
  }

  private async createAndAttachCliChat(telegramChatId: string, cwd: string): Promise<void> {
    try {
      const { chatId } = await createCliChat({
        agentBin: this.config.cliBridge.agentBin,
        cwd,
        apiKey: this.config.cursorApiKey || undefined,
      });
      const name = cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
      const prev = this.cliAttaches.get(telegramChatId);
      this.setCliAttach(telegramChatId, {
        chatId,
        cwd,
        title: `New · ${name}`,
        mode: prev?.mode ?? 'agent',
      });
      await this.sendMessage(
        telegramChatId,
        `✅ Created and attached CLI chat\nId: \`${chatId}\`\ncwd: \`${cwd}\`\nCLI mode: ${prev?.mode ?? 'agent'}\n\nSend text to start. /cli mode plan|ask|agent`
      );
    } catch (err) {
      await this.sendMessage(
        telegramChatId,
        `❌ Failed to create CLI chat: ${formatTelegramError(err)}`
      );
    }
  }

  private enqueueCliJob(telegramChatId: string, attach: CliAttach, text: string): void {
    const alreadyBusy =
      this.cliQueue.isRunning(telegramChatId) || this.cliQueue.pendingCount(telegramChatId) > 0;

    this.cliQueue.setProcessor(telegramChatId, async (job) => {
      await this.runCliJob(job.payload);
    });

    const { position } = this.cliQueue.enqueue(telegramChatId, {
      telegramChatId,
      attach,
      text,
    });

    if (alreadyBusy || position > 1) {
      void this.sendMessage(
        telegramChatId,
        `⏳ Queued for CLI ${attach.title} (#${position})`
      );
    }
  }

  private async runCliJob(payload: CliJobPayload): Promise<void> {
    const { telegramChatId, attach, text } = payload;
    const lock = tryAcquireCliChatLock(attach.chatId);
    if (!lock.ok) {
      await this.sendMessage(
        telegramChatId,
        `❌ CLI chat locked by another cursor-cp process (pid ${lock.holder.pid}). Try again later.`
      );
      return;
    }

    let statusMsgId: number | undefined;
    let accumulated = '';
    let lastEdit = 0;
    const interval = this.config.cliBridge.streamEditIntervalMs || 1200;

    try {
      const status = await this.bot.telegram.sendMessage(
        telegramChatId,
        `⏳ CLI: ${attach.title}…`
      );
      statusMsgId = status.message_id;

      const result = await this.cliRunner.run({
        agentBin: this.config.cliBridge.agentBin,
        chatId: attach.chatId,
        cwd: attach.cwd,
        prompt: text,
        mode: this.cliAttaches.get(telegramChatId)?.mode ?? attach.mode ?? 'agent',
        force: this.config.cliBridge.force,
        trust: this.config.cliBridge.trust,
        timeoutMs: this.config.cliBridge.timeoutMs,
        apiKey: this.config.cursorApiKey || undefined,
        onChunk: (delta) => {
          accumulated += delta;
          const now = Date.now();
          if (now - lastEdit < interval || !statusMsgId) return;
          lastEdit = now;
          const preview = truncateTelegram(accumulated || '…');
          void this.bot.telegram
            .editMessageText(telegramChatId, statusMsgId, undefined, preview)
            .catch(() => {
              /* ignore edit races */
            });
        },
      });

      const finalText = result.success
        ? result.text
        : `❌ ${result.error || 'CLI run failed'}${result.text ? `\n\n${result.text}` : ''}`;

      if (statusMsgId) {
        try {
          await this.bot.telegram.editMessageText(
            telegramChatId,
            statusMsgId,
            undefined,
            truncateTelegram(finalText)
          );
          return;
        } catch {
          // fall through to sendMessage
        }
      }
      await this.sendMessage(telegramChatId, finalText);
      logger.info({ telegramChatId, cliChatId: attach.chatId }, 'CLI print run completed');
    } catch (err) {
      logger.error({ err, telegramChatId, cliChatId: attach.chatId }, 'CLI message failed');
      await this.sendMessage(telegramChatId, `❌ ${formatTelegramError(err)}`);
    } finally {
      releaseCliChatLock(attach.chatId);
    }
  }

  private async resolveOrCreateSession(
    chatId: string,
    ctx: Context<Update>
  ): Promise<string> {
    let sessionId = this.activeSessions.get(chatId);

    if (!sessionId) {
      const sessions = this.sessionManager.listAllSessions(false);
      const existing = sessions.find((s) => s.channel === 'telegram' && s.channelKey === chatId);

      if (existing) {
        sessionId = existing.id;
        this.activeSessions.set(chatId, sessionId);
        logger.info({ chatId, sessionId }, 'Reconnected to existing Telegram session');
      } else {
        const session = await this.sessionManager.createSession(
          'telegram',
          chatId,
          '',
          'Telegram Session'
        );
        sessionId = session.id;
        this.activeSessions.set(chatId, sessionId);
        logger.info({ chatId, sessionId }, 'Created new Telegram session');
        await ctx.reply('✅ Created new session. Processing your message…');
      }
    }

    return sessionId;
  }

  private async processSessionMessage(
    sessionId: string,
    text: string,
    chatId: string
  ): Promise<void> {
    try {
      await this.sessionManager.sendSessionMessage(sessionId, text, 'telegram', chatId);
      logger.info({ chatId, sessionId }, 'Telegram message dispatched to agent');
    } catch (err) {
      logger.error({ err, chatId, sessionId }, 'Telegram session message failed');
      await this.sendMessage(chatId, `❌ ${formatTelegramError(err)}`);
    }
  }

  async start(): Promise<void> {
    this.bot.catch((err, ctx) => {
      logger.error({ err, updateType: ctx?.updateType }, 'Telegraf polling error');
      if (ctx) {
        void replySafe(ctx, `❌ ${formatTelegramError(err)}`);
      }
    });

    await this.bot.launch();
    await this.syncBotCommands();
    logger.info('Telegram bot polling started');
  }

  async stop(): Promise<void> {
    this.cliRunner.cancel();
    this.bot.stop();
    logger.info('Telegram bot stopped');
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!text) return;

    logger.debug({ conversationId, textLength: text.length }, 'Sending Telegram message');

    if (text.length <= 4096) {
      await this.sendMarkdownMessage(conversationId, text);
      return;
    }

    for (const chunk of splitPlainText(text, 4096)) {
      await this.sendMarkdownMessage(conversationId, chunk);
    }
  }

  /** Send markdown with HTML formatting (matches web bold/italic); plain text on failure. */
  private async sendMarkdownMessage(conversationId: string, markdown: string): Promise<void> {
    const html = markdownToTelegramHtml(markdown);
    if (html) {
      try {
        await this.bot.telegram.sendMessage(conversationId, html, { parse_mode: 'HTML' });
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'Telegram rejected HTML message, sending plain');
      }
    }

    const plain = markdownToTelegram(markdown);
    try {
      await this.bot.telegram.sendMessage(conversationId, plain.text.slice(0, 4096));
    } catch (err) {
      logger.error({ err, conversationId }, 'Failed to send Telegram message chunk');
      throw err;
    }
  }

  private async sendFormattedWithKeyboard(
    conversationId: string,
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard>
  ): Promise<void> {
    const html = markdownToTelegramHtml(text);
    if (html) {
      try {
        await this.bot.telegram.sendMessage(conversationId, html, {
          parse_mode: 'HTML',
          ...keyboard,
        });
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'Telegram rejected formatted question, sending plain');
      }
    }

    const plain = markdownToTelegram(text);
    await this.bot.telegram.sendMessage(
      conversationId,
      plain.text.slice(0, 4096),
      keyboard
    );
  }

  async askQuestion(
    conversationId: string,
    question: string,
    options: string[],
    target: MessageTarget
  ): Promise<string> {
    const token = this.createQuestionToken(target.sessionId, conversationId);

    const buttons = options.map((opt, i) => {
      return [Markup.button.callback(opt, `q:${token}:${i}`)];
    });

    await this.sendFormattedWithKeyboard(
      conversationId,
      question,
      Markup.inlineKeyboard(buttons)
    );

    return new Promise((resolve) => {
      this.pendingQuestions.set(token, {
        resolve,
        options,
        sessionId: target.sessionId,
      });

      // Set up one-time handler for this question
      this.bot.action(new RegExp(`q:${token}:(\\d+)`), async (ctx) => {
        const index = parseInt(ctx.match[1], 10);
        const pending = this.pendingQuestions.get(token);

        if (pending) {
          pending.resolve(pending.options[index] || '');
          this.pendingQuestions.delete(token);
          await ctx.answerCbQuery();
          await ctx.reply(`✅ Selected: ${pending.options[index]}`);
        }
      });

      // Timeout after 1 hour
      setTimeout(() => {
        const pending = this.pendingQuestions.get(token);
        if (pending) {
          pending.resolve(pending.options[0] || '');
          this.pendingQuestions.delete(token);
        }
      }, 3600000);
    });
  }

  private createQuestionToken(sessionId: string, conversationId: string): string {
    return createHash('sha256')
      .update(`${sessionId}:${conversationId}`)
      .digest('hex')
      .slice(0, 12);
  }
}

function truncateTelegram(text: string, max = 4096): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
