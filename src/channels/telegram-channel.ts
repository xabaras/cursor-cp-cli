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
  normalizeCliModel,
  formatCliModelLabel,
  type CliAgentMode,
} from '../core/cli-attach-store.js';
import { CliJobQueue } from '../core/cli-job-queue.js';
import { createCliChat } from '../core/cli-create-chat.js';
import { listCliModels, mapSdkModelIdForCli } from '../core/cli-list-models.js';
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
  /** Omitted = Auto (no --model). */
  model?: string;
}

interface CliJobPayload {
  telegramChatId: string;
  attach: CliAttach;
  text: string;
}

interface CliActiveJobInfo {
  telegramChatId: string;
  attach: CliAttach;
  startedAt: number;
}

function cliQueueKey(telegramChatId: string, cliChatId: string): string {
  return `${telegramChatId}:${cliChatId}`;
}

/**
 * Inline-button callback routes. Telegraf runs the first handler whose pattern
 * matches, so every one is anchored: unanchored, /ws:(\d+)/ swallowed
 * `cli:newws:N` and answered "Invalid selection" for every /cli new pick.
 */
export const CALLBACK_PATTERNS = {
  session: /^session:(.+)$/,
  model: /^model:(\d+)$/,
  cliModel: /^cli:model:(\d+)$/,
  gh: /^gh:(\d+)$/,
  ws: /^ws:(\d+)$/,
  cli: /^cli:(.+)$/,
  question: (token: string) => new RegExp(`^q:${token}:(\\d+)$`),
} as const;

export const CLI_CHAT_PAGE_SIZE = 20;

type InlineButton = ReturnType<typeof Markup.button.callback>;

export interface CliChatPage {
  text: string;
  buttons: InlineButton[][];
  page: number;
  pages: number;
}

/**
 * One page of the /cli picker. Chat buttons carry the index into the full
 * list (`cli:<i>`), so a pick on any page resolves against pendingCliChats.
 */
export function buildCliChatPage(
  chats: CliChatMeta[],
  page: number,
  header: string,
  pageSize = CLI_CHAT_PAGE_SIZE
): CliChatPage {
  const pages = Math.max(1, Math.ceil(chats.length / pageSize));
  const current = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const start = current * pageSize;

  const buttons: InlineButton[][] = chats
    .slice(start, start + pageSize)
    .map((chat, i) => [Markup.button.callback(formatCliChatLabel(chat), `cli:${start + i}`)]);

  if (pages > 1) {
    const nav: InlineButton[] = [];
    if (current > 0) nav.push(Markup.button.callback('« Prev', `cli:page:${current - 1}`));
    if (current < pages - 1) nav.push(Markup.button.callback('Next »', `cli:page:${current + 1}`));
    buttons.push(nav);
  }
  buttons.push([Markup.button.callback('Detach CLI (/cli off)', 'cli:off')]);

  const text =
    pages > 1 ? `${header}\n\nPage ${current + 1}/${pages} · ${chats.length} chats` : header;
  return { text, buttons, page: current, pages };
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
  /** Header of the /cli picker, reused when paging through pendingCliChats. */
  private pendingCliChatHeaders: Map<string, string> = new Map();
  // Pending workspaces for /cli new
  private pendingCliNewWorkspaces: Map<string, string[]> = new Map();
  // Pending workspaces for /cli cwd
  private pendingCliCwdWorkspaces: Map<string, string[]> = new Map();
  /** Pending model ids for /cli model (from agent --list-models). */
  private pendingCliModels: Map<string, string[]> = new Map();
  // Active CLI attach per Telegram chat (overrides SDK routing for text)
  private cliAttaches: Map<string, CliAttach> = new Map();
  private cliRunner = new CliPrintRunner();
  private cliQueue = new CliJobQueue<CliJobPayload>();
  /** Running/queued job metadata for /cli status (keyed by cliChatId). */
  private cliActiveJobs = new Map<string, CliActiveJobInfo>();
  /** Attach targets + reply text for "Switch to …" buttons (keyed by cliChatId). */
  private pendingCliSwitchAttaches = new Map<
    string,
    { attach: CliAttach; finalText: string }
  >();

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
      const model = normalizeCliModel(attach.model);
      this.cliAttaches.set(key, {
        chatId: attach.chatId,
        cwd: attach.cwd,
        title: attach.title,
        mode: normalizeCliAgentMode(attach.mode),
        ...(model ? { model } : {}),
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
    const model = normalizeCliModel(attach.model);
    this.cliAttaches.set(telegramChatId, {
      ...attach,
      mode: normalizeCliAgentMode(attach.mode),
      ...(model ? { model } : { model: undefined }),
    });
    // Drop explicit undefined so JSON omit works via save of optional field
    const stored = this.cliAttaches.get(telegramChatId)!;
    if (!model) delete stored.model;
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

  /** Resolve Telegram chat id from a callback query (ctx.chat can be missing). */
  private callbackChatId(ctx: Context<Update>): string {
    if (ctx.chat?.id != null) return String(ctx.chat.id);
    const q = ctx.callbackQuery;
    if (q && 'message' in q && q.message && 'chat' in q.message && q.message.chat?.id != null) {
      return String(q.message.chat.id);
    }
    return '';
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
        description: 'CLI chats: list/mode/model/cwd/new/cancel/off (see /start)',
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
                '/cli cwd - Change workspace for the attached CLI chat',
                '/cli model - Pick model for the attached CLI chat (incl. Auto)',
                '/cli mode [agent|plan|ask] - Show or set CLI execution mode',
                '/cli plan|/cli ask|/cli agent - Shortcuts for /cli mode',
                '/cli cancel - Stop the attached CLI chat run',
                '/cli cancel all - Stop all runs and clear queues',
                '/cli off - Detach CLI mode (back to SDK sessions)',
                '/cli status - Show attach + active/queued CLI jobs',
                '',
                'With a CLI chat attached, plain text continues that chat',
                '(queued per chat; different chats can run in parallel).',
                'Switch attach anytime; background jobs keep running.',
                'Long runs do not time out by default; use /cli cancel to stop.',
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
        await ctx.reply('✅ Detached from CLI chat. Text now uses SDK sessions.');
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
        await this.handleCliCancel(ctx, chatId, argLower === 'cancel all' || argLower.endsWith(' all'));
        return;
      }

      if (argLower === 'new') {
        await this.startCliNew(ctx, chatId);
        return;
      }

      if (argLower === 'cwd' || argLower === 'workspace' || argLower === 'workdir') {
        await this.startCliCwd(ctx, chatId);
        return;
      }

      if (argLower === 'model' || argLower.startsWith('model ')) {
        await this.startCliModel(ctx, chatId);
        return;
      }

      const listAll = argLower === 'all';
      await this.replyCliChatList(ctx, chatId, { listAll });
    });

    // Handle session selection callback
    this.bot.action(CALLBACK_PATTERNS.session, async (ctx) => {
      const sessionId = ctx.match[1];
      const chatId = String(ctx.chat?.id);

      this.clearCliAttach(chatId);
      await this.sessionManager.joinSession(sessionId, 'telegram', chatId);
      this.activeSessions.set(chatId, sessionId);

      await ctx.answerCbQuery('Connected to session');
      await ctx.reply('✅ Connected to SDK session (CLI attach cleared). You can now send messages.');
    });

    // SDK /models picker only (must be ^anchored — must NOT match cli:model:N)
    this.bot.action(CALLBACK_PATTERNS.model, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = this.callbackChatId(ctx);
      const models = this.modelIds.get(chatId);

      if (!models || !models[index]) {
        await ctx.answerCbQuery('Expired — send /models again', { show_alert: true });
        return;
      }
      const model = models[index];
      this.sessionManager.setDefaultModel(model);
      await ctx.answerCbQuery(`Default model set to ${model}`);
      await ctx.reply(`✅ Default model set to: ${model}`);
    });

    // CLI /cli model picker (dedicated — registered before generic cli: handler)
    this.bot.action(CALLBACK_PATTERNS.cliModel, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = this.callbackChatId(ctx);
      const options = this.pendingCliModels.get(chatId);
      const attach = this.cliAttaches.get(chatId);

      if (!attach || !options || Number.isNaN(index) || index < 0 || index >= options.length) {
        logger.warn(
          { chatId, index, hasOptions: !!options, hasAttach: !!attach },
          'CLI model selection invalid or expired'
        );
        await ctx.answerCbQuery('Expired — send /cli model again', { show_alert: true });
        return;
      }

      const nextModel = options[index];
      this.setCliAttach(chatId, { ...attach, model: nextModel });
      this.pendingCliModels.delete(chatId);

      const label = formatCliModelLabel(nextModel);
      const confirm =
        `✅ Model updated for ${attach.title}: ${label} (${nextModel})\n` +
        `Applies to the next message.`;

      try {
        await ctx.answerCbQuery(`Model set: ${label}`.slice(0, 200));
      } catch (err) {
        logger.warn({ err }, 'answerCbQuery failed for CLI model');
      }

      // Drop the picker so the chat stays short, then send confirmation (scrolls to bottom)
      try {
        await ctx.deleteMessage();
      } catch (err) {
        logger.warn({ err, chatId }, 'Could not delete CLI model picker message');
      }

      try {
        await this.sendMessage(chatId, confirm);
      } catch (err) {
        logger.warn({ err, chatId }, 'Could not send CLI model confirmation');
      }

      logger.info(
        { telegramChatId: chatId, cliChatId: attach.chatId, model: nextModel },
        'CLI model updated'
      );
    });

    // Handle GitHub repo selection
    this.bot.action(CALLBACK_PATTERNS.gh, async (ctx) => {
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
    this.bot.action(CALLBACK_PATTERNS.ws, async (ctx) => {
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
    this.bot.action(CALLBACK_PATTERNS.cli, async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const key = ctx.match[1];

      if (key === 'off') {
        this.clearCliAttach(chatId);
        await ctx.answerCbQuery('Detached');
        await ctx.reply('✅ Detached from CLI chat. Text now uses SDK sessions.');
        return;
      }

      if (key.startsWith('sw:')) {
        const cliChatId = key.slice('sw:'.length);
        const pending = this.pendingCliSwitchAttaches.get(cliChatId);
        if (!pending || pending.attach.chatId !== cliChatId) {
          await ctx.answerCbQuery('Switch target expired');
          return;
        }
        const { attach, finalText } = pending;
        this.setCliAttach(chatId, attach);
        await ctx.answerCbQuery(`Attached: ${attach.title}`);
        await ctx.reply(
          `✅ Switched to CLI chat *${attach.title}*\n` +
            `Id: \`${attach.chatId}\`\n` +
            `CLI mode: ${attach.mode}\n` +
            `Model: ${formatCliModelLabel(attach.model)}`,
          { parse_mode: 'Markdown' }
        );
        if (finalText.trim()) {
          await this.sendMessage(chatId, finalText);
        }
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

      if (key.startsWith('cwd:')) {
        const index = Number.parseInt(key.slice('cwd:'.length), 10);
        const paths = this.pendingCliCwdWorkspaces.get(chatId);
        const attach = this.cliAttaches.get(chatId);
        if (!attach || !paths || Number.isNaN(index) || !paths[index]) {
          await ctx.answerCbQuery('Invalid selection');
          return;
        }
        if (this.cliRunner.isRunning(attach.chatId)) {
          await ctx.answerCbQuery('Chat is busy');
          await ctx.reply(
            'Cannot change cwd while this CLI chat has a run in progress. Wait or `/cli cancel`.'
          );
          return;
        }
        const nextCwd = paths[index];
        this.setCliAttach(chatId, { ...attach, cwd: nextCwd });
        this.pendingCliCwdWorkspaces.delete(chatId);
        await ctx.answerCbQuery('cwd updated');
        await ctx.reply(
          `✅ Workspace updated for *${attach.title}*\n` +
            `cwd: \`${nextCwd}\`\n` +
            `Applies to the next message (not an in-flight run).`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (key.startsWith('page:')) {
        const page = Number.parseInt(key.slice('page:'.length), 10);
        const chats = this.pendingCliChats.get(chatId);
        const header = this.pendingCliChatHeaders.get(chatId);
        if (!chats || !header || Number.isNaN(page)) {
          await ctx.answerCbQuery('Expired — send /cli again');
          return;
        }
        const view = buildCliChatPage(chats, page, header);
        try {
          await ctx.editMessageText(view.text, Markup.inlineKeyboard(view.buttons));
        } catch (err) {
          logger.warn({ err, chatId, page }, 'Could not page the CLI chat list');
        }
        await ctx.answerCbQuery(`Page ${view.page + 1}/${view.pages}`);
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
        model: prev?.model,
      });

      await ctx.answerCbQuery(`Attached: ${chat.title}`);
      await ctx.reply(
        `✅ Attached CLI chat *${chat.title}*\n` +
          `Id: \`${chat.chatId}\`\n` +
          `cwd: \`${chat.cwd}\`\n` +
          `CLI mode: ${prev?.mode ?? 'agent'}\n` +
          `Model: ${formatCliModelLabel(prev?.model)}\n\n` +
          'Send text to continue this chat via `agent -p --resume`.\n' +
          'Note: runs with --force (no tool approval prompts). /cli mode · /cli model · /cli off',
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
    const lines: string[] = [];
    if (!attach) {
      lines.push('Mode: SDK sessions (no CLI attach).', 'Use /cli to attach a Cursor CLI chat.');
    } else {
      const qKey = cliQueueKey(chatId, attach.chatId);
      const pending = this.cliQueue.pendingCount(qKey);
      const running = this.cliRunner.isRunning(attach.chatId) || this.cliQueue.isRunning(qKey);
      lines.push(
        'Mode: *CLI attached*',
        `Title: ${attach.title}`,
        `Id: \`${attach.chatId}\``,
        `cwd: \`${attach.cwd}\``,
        `CLI mode: ${attach.mode}`,
        `Model: ${formatCliModelLabel(attach.model)}`,
        `This chat run: ${running ? 'active' : 'idle'}` + (pending ? ` · queue: ${pending}` : '')
      );
    }

    const prefix = `${chatId}:`;
    const jobLines: string[] = [];
    for (const qKey of this.cliQueue.listActiveKeys()) {
      if (!qKey.startsWith(prefix)) continue;
      const cliId = qKey.slice(prefix.length);
      const info = this.cliActiveJobs.get(cliId);
      const title = info?.attach.title ?? cliId.slice(0, 8);
      const state = this.cliRunner.isRunning(cliId)
        ? 'running'
        : this.cliQueue.isRunning(qKey)
          ? 'running'
          : 'queued';
      const pending = this.cliQueue.pendingCount(qKey);
      jobLines.push(
        `• ${state}: ${title} (\`${cliId.slice(0, 8)}…\`)` +
          (pending ? ` · +${pending} queued` : '')
      );
    }
    if (jobLines.length > 0) {
      lines.push('', 'Active / tracked CLI jobs:', ...jobLines);
    } else if (attach) {
      lines.push('', 'No background CLI jobs.');
    }

    lines.push(
      '',
      'Tool approvals: none (--force). /cli cancel · /cli cancel all · /cli off'
    );
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  }

  private async handleCliCancel(
    ctx: Context<Update>,
    telegramChatId: string,
    all: boolean
  ): Promise<void> {
    if (all) {
      let cancelled = 0;
      let cleared = 0;
      const prefix = `${telegramChatId}:`;
      const keys = new Set([
        ...this.cliQueue.listActiveKeys().filter((k) => k.startsWith(prefix)),
        ...[...this.cliActiveJobs.entries()]
          .filter(([, info]) => info.telegramChatId === telegramChatId)
          .map(([cliId]) => cliQueueKey(telegramChatId, cliId)),
      ]);
      for (const qKey of keys) {
        const cliId = qKey.slice(prefix.length);
        if (this.cliRunner.isRunning(cliId)) {
          this.cliRunner.cancel(cliId);
          cancelled += 1;
        }
        cleared += this.cliQueue.clear(qKey);
        this.cliActiveJobs.delete(cliId);
      }
      if (cancelled === 0 && cleared === 0) {
        await ctx.reply('Nothing to cancel (no active CLI runs / empty queues).');
        return;
      }
      await ctx.reply(
        `✅ Cancelled ${cancelled} run(s) and cleared ${cleared} queued job(s).`
      );
      return;
    }

    const attach = this.cliAttaches.get(telegramChatId);
    if (!attach) {
      await ctx.reply('No CLI chat attached. Attach one or use `/cli cancel all`.');
      return;
    }
    const qKey = cliQueueKey(telegramChatId, attach.chatId);
    const wasRunning = this.cliRunner.isRunning(attach.chatId);
    this.cliRunner.cancel(attach.chatId);
    const cleared = this.cliQueue.clear(qKey);
    this.cliActiveJobs.delete(attach.chatId);
    if (!wasRunning && cleared === 0) {
      await ctx.reply('Nothing to cancel for the attached CLI chat.');
      return;
    }
    await ctx.reply(
      wasRunning
        ? `✅ Cancel signal sent to ${attach.title}` +
          (cleared ? ` (cleared ${cleared} queued).` : '.')
        : `✅ Cleared ${cleared} queued job(s) for ${attach.title}.`
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
        limit: Infinity,
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

      const attached = this.cliAttaches.get(chatId);
      const scope = filter ? `(filtered: ${filter})` : '(all chats)';
      const header = attached
        ? `Currently attached: ${attached.title}\n${scope}\n\nPick a Cursor CLI chat:`
        : `Cursor CLI chats ${scope} — tap to attach:`;

      this.pendingCliChats.set(chatId, chats);
      this.pendingCliChatHeaders.set(chatId, header);
      const { text, buttons } = buildCliChatPage(chats, 0, header);
      await ctx.reply(text, Markup.inlineKeyboard(buttons));
    } catch (err) {
      logger.error({ err }, 'Failed to list CLI chats');
      await ctx.reply('Could not list CLI chats.');
    }
  }

  private async startCliModel(ctx: Context<Update>, chatId: string): Promise<void> {
    const attach = this.cliAttaches.get(chatId);
    if (!attach) {
      await ctx.reply('No CLI chat attached. Use /cli to attach one first.');
      return;
    }

    const status = await ctx.reply('Retrieving models list…');
    const statusMsgId = status.message_id;

    try {
      let models = await listCliModels({
        agentBin: this.config.cliBridge.agentBin,
        apiKey: this.config.cursorApiKey || undefined,
      });

      if (models.length === 0) {
        const sdk = await this.sessionManager.getAgentService().listAvailableModels();
        models = sdk
          .filter((m) => m.id)
          .map((m) => ({
            id: mapSdkModelIdForCli(m.id),
            name: m.name || m.id,
          }));
        // Dedupe after default→auto remap
        const seen = new Set<string>();
        models = models.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      }

      if (models.length === 0) {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsgId,
          undefined,
          'No models available from the Cursor CLI.'
        );
        return;
      }

      const ids = models.map((m) => m.id);
      this.pendingCliModels.set(chatId, ids);
      const current = normalizeCliModel(attach.model) ?? 'auto';

      const buttons = models.map((m, i) => {
        const mark = current === m.id ? '✓ ' : '';
        const label = `${mark}${m.name || m.id}`.slice(0, 60);
        return [Markup.button.callback(label, `cli:model:${i}`)];
      });

      const header =
        `Current model: ${formatCliModelLabel(attach.model)} (${current})\n` +
        `Pick a model for ${attach.title}:`;
      try {
        await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, header, {
          ...Markup.inlineKeyboard(buttons),
        });
      } catch {
        await ctx.reply(header, Markup.inlineKeyboard(buttons));
      }
    } catch (err) {
      logger.error({ err }, 'Failed to list models for /cli model');
      try {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsgId,
          undefined,
          'Could not list models for /cli model.'
        );
      } catch {
        await ctx.reply('Could not list models for /cli model.');
      }
    }
  }

  private async startCliCwd(ctx: Context<Update>, chatId: string): Promise<void> {
    const attach = this.cliAttaches.get(chatId);
    if (!attach) {
      await ctx.reply('No CLI chat attached. Use /cli to attach one first.');
      return;
    }
    if (this.cliRunner.isRunning(attach.chatId)) {
      await ctx.reply(
        'Cannot change cwd while this CLI chat has a run in progress. Wait or `/cli cancel`.'
      );
      return;
    }

    try {
      const items = await listLocalWorkspaceItems(this.config);
      if (items.length === 0) {
        await ctx.reply(
          `No workspaces under ${this.config.workspaceRoot}. Add a project folder first.`
        );
        return;
      }
      const paths = items.map((i) => i.path);
      this.pendingCliCwdWorkspaces.set(chatId, paths);
      const buttons = items.map((item, i) => {
        const name = item.path.split(/[/\\]/).pop() || item.label;
        const mark = item.path === attach.cwd ? ' ✓' : '';
        return [Markup.button.callback(`${name}${mark}`.slice(0, 60), `cli:cwd:${i}`)];
      });
      await ctx.reply(
        `Current cwd: \`${attach.cwd}\`\nPick a new workspace for *${attach.title}*:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
      );
    } catch (err) {
      logger.error({ err }, 'Failed to list workspaces for /cli cwd');
      await ctx.reply('Could not list workspaces for /cli cwd.');
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
        model: prev?.model,
      });
      await this.sendMessage(
        telegramChatId,
        `✅ Created and attached CLI chat\nId: \`${chatId}\`\ncwd: \`${cwd}\`\nCLI mode: ${prev?.mode ?? 'agent'}\nModel: ${formatCliModelLabel(prev?.model)}\n\nSend text to start. /cli mode · /cli model`
      );
    } catch (err) {
      await this.sendMessage(
        telegramChatId,
        `❌ Failed to create CLI chat: ${formatTelegramError(err)}`
      );
    }
  }

  private enqueueCliJob(telegramChatId: string, attach: CliAttach, text: string): void {
    const qKey = cliQueueKey(telegramChatId, attach.chatId);
    const alreadyBusy =
      this.cliQueue.isRunning(qKey) || this.cliQueue.pendingCount(qKey) > 0;

    this.cliQueue.setProcessor(qKey, async (job) => {
      await this.runCliJob(job.payload);
    });

    const { position } = this.cliQueue.enqueue(qKey, {
      telegramChatId,
      attach,
      text,
    });

    if (alreadyBusy || position > 1) {
      void this.sendMessage(
        telegramChatId,
        `⏳ Queued for CLI ${attach.title} (${attach.chatId.slice(0, 8)}…) #${position}`
      );
    }
  }

  private isCliChatAttached(telegramChatId: string, cliChatId: string): boolean {
    return this.cliAttaches.get(telegramChatId)?.chatId === cliChatId;
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
    let streaming = this.isCliChatAttached(telegramChatId, attach.chatId);
    let backgroundNotified = false;
    const interval = this.config.cliBridge.streamEditIntervalMs || 1200;

    this.cliActiveJobs.set(attach.chatId, {
      telegramChatId,
      attach,
      startedAt: Date.now(),
    });

    try {
      const status = await this.bot.telegram.sendMessage(
        telegramChatId,
        streaming
          ? `⏳ CLI: ${attach.title}…`
          : `⏳ CLI background: ${attach.title} (${attach.chatId.slice(0, 8)}…) — streaming paused (not attached)`
      );
      statusMsgId = status.message_id;

      const liveAttach = this.cliAttaches.get(telegramChatId);
      const result = await this.cliRunner.run({
        agentBin: this.config.cliBridge.agentBin,
        chatId: attach.chatId,
        cwd: liveAttach?.chatId === attach.chatId ? liveAttach.cwd : attach.cwd,
        prompt: text,
        mode: liveAttach?.mode ?? attach.mode ?? 'agent',
        model: liveAttach?.chatId === attach.chatId ? liveAttach.model : attach.model,
        force: this.config.cliBridge.force,
        trust: this.config.cliBridge.trust,
        timeoutMs: this.config.cliBridge.timeoutMs,
        apiKey: this.config.cursorApiKey || undefined,
        onChunk: (delta) => {
          accumulated += delta;
          const attachedNow = this.isCliChatAttached(telegramChatId, attach.chatId);
          if (!attachedNow) {
            if (streaming && statusMsgId && !backgroundNotified) {
              backgroundNotified = true;
              streaming = false;
              void this.bot.telegram
                .editMessageText(
                  telegramChatId,
                  statusMsgId,
                  undefined,
                  `⏳ CLI background: ${attach.title} — still running (not attached)`
                )
                .catch(() => {
                  /* ignore */
                });
            }
            return;
          }
          streaming = true;
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

      const body = result.success
        ? result.text
        : `❌ ${result.error || 'CLI run failed'}${result.text ? `\n\n${result.text}` : ''}`;
      const header =
        `CLI done · ${attach.title}\n` +
        `Id: \`${attach.chatId}\`\n\n`;
      const finalText = header + body;
      const stillAttached = this.isCliChatAttached(telegramChatId, attach.chatId);
      const notifyOnComplete = this.config.cliBridge.notifyOnComplete !== false;
      const completeMeta = {
        telegramChatId,
        cliChatId: attach.chatId,
        textLength: finalText.length,
        resultLen: result.resultLen,
        assistantLen: result.assistantLen,
        stillAttached,
      };

      if (notifyOnComplete || !stillAttached || !statusMsgId) {
        await this.deliverCliCompletion(telegramChatId, attach, finalText, stillAttached);
        if (statusMsgId && (streaming || stillAttached)) {
          try {
            await this.bot.telegram.deleteMessage(telegramChatId, statusMsgId);
          } catch (err) {
            logger.debug(
              { err, telegramChatId, statusMsgId },
              'Could not delete CLI stream preview message'
            );
          }
        } else if (statusMsgId && !stillAttached) {
          try {
            await this.bot.telegram.deleteMessage(telegramChatId, statusMsgId);
          } catch {
            /* ignore */
          }
        }
        logger.info({ ...completeMeta, via: 'notify-send' }, 'CLI print run completed');
        return;
      }

      // notify_on_complete: false and still attached — finalize in-place via edit
      const finalPreview = truncateTelegram(finalText);
      const alreadyShown =
        truncateTelegram(accumulated || '') === finalPreview ||
        accumulated.trim() === body.trim();
      if (alreadyShown) {
        logger.info({ ...completeMeta, via: 'stream-preview' }, 'CLI print run completed');
        return;
      }

      try {
        await this.bot.telegram.editMessageText(
          telegramChatId,
          statusMsgId,
          undefined,
          finalPreview
        );
        logger.info({ ...completeMeta, via: 'edit' }, 'CLI print run completed');
        return;
      } catch (err) {
        if (isTelegramMessageNotModified(err)) {
          logger.info({ ...completeMeta, via: 'edit-unchanged' }, 'CLI print run completed');
          return;
        }
        logger.warn(
          { err, telegramChatId, cliChatId: attach.chatId },
          'Final CLI status edit failed; sending as new message'
        );
      }
      await this.deliverCliCompletion(telegramChatId, attach, finalText, stillAttached);
      logger.info({ ...completeMeta, via: 'send' }, 'CLI print run completed');
    } catch (err) {
      logger.error({ err, telegramChatId, cliChatId: attach.chatId }, 'CLI message failed');
      await this.sendMessage(telegramChatId, `❌ ${formatTelegramError(err)}`);
    } finally {
      this.cliActiveJobs.delete(attach.chatId);
      releaseCliChatLock(attach.chatId);
    }
  }

  /** Final CLI reply; adds Switch to… button when that chat is not currently attached. */
  private async deliverCliCompletion(
    telegramChatId: string,
    attach: CliAttach,
    finalText: string,
    stillAttached: boolean
  ): Promise<void> {
    if (stillAttached) {
      await this.sendMessage(telegramChatId, finalText);
      return;
    }

    this.pendingCliSwitchAttaches.set(attach.chatId, { attach, finalText });
    const label = `Switch to ${attach.title}`.slice(0, 64);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(label, `cli:sw:${attach.chatId}`)],
    ]);

    // First chunk (or whole message) with keyboard; overflow as plain follow-ups
    if (finalText.length <= 4096) {
      await this.sendFormattedWithKeyboard(telegramChatId, finalText, keyboard);
      return;
    }

    const chunks = splitPlainText(finalText, 4096);
    const [first, ...rest] = chunks;
    await this.sendFormattedWithKeyboard(telegramChatId, first, keyboard);
    for (const chunk of rest) {
      await this.sendMarkdownMessage(telegramChatId, chunk);
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
      this.bot.action(CALLBACK_PATTERNS.question(token), async (ctx) => {
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

/** Telegram returns this when editMessageText content matches the current message. */
function isTelegramMessageNotModified(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  if (err && typeof err === 'object') {
    const o = err as { description?: unknown; response?: { description?: unknown } };
    if (o.description != null) parts.push(String(o.description));
    if (o.response?.description != null) parts.push(String(o.response.description));
  }
  parts.push(String(err ?? ''));
  return parts.some((p) => /message is not modified/i.test(p));
}
