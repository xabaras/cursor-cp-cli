/**
 * Cursor Control Plane + CLI - Entry Point
 * TypeScript + Cursor SDK Edition (fork with CLI bridge)
 */

import fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { loadConfig, requireCursorApiKey } from './config/loader.js';
import { getDatabase } from './db/connection.js';
import {
  SessionRepository,
  MessageRepository,
  ParticipantRepository,
  SettingsRepository,
} from './db/repositories.js';
import { AgentService } from './core/agent-service.js';
import { SessionManager } from './core/session-manager.js';
import { EventBus } from './core/events.js';
import { WebChannel } from './channels/web-channel.js';
import { TelegramChannel } from './channels/telegram-channel.js';
import { ChannelRegistryImpl } from './channels/registry.js';
import { registerApi } from './api/register-api.js';
import { logger, getLogFilePath, createFastifyLoggerConfig, initLogging } from './util/logger.js';
import { ensureProjectDirs, projectHomeDir } from './paths.js';
import { APP_DISPLAY_NAME } from './cli/help.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function registerProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection (process continues)');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
  });
}

async function main() {
  registerProcessErrorHandlers();
  const { config } = loadConfig();
  initLogging(config.logging);
  requireCursorApiKey(config);

  ensureProjectDirs();

  const logFile = getLogFilePath();
  if (logFile) {
    logger.info({ logFile, projectHome: projectHomeDir() }, 'File logging enabled');
  } else {
    logger.info('File logging disabled');
  }

  const db = getDatabase();

  const repositories = {
    sessions: new SessionRepository(db.db),
    messages: new MessageRepository(db.db),
    participants: new ParticipantRepository(db.db),
    settings: new SettingsRepository(db.db),
  };

  const eventBus = new EventBus();

  const agentService = new AgentService({
    apiKey: config.cursorApiKey,
    defaultModel: config.sdk.defaultModel,
  });

  const channelRegistry = new ChannelRegistryImpl();

  const sessionManager = new SessionManager({
    repositories,
    agentService,
    eventBus,
    registry: channelRegistry,
    maxSessions: config.sdk.maxSessions,
    defaultModel: config.sdk.defaultModel,
  });

  let webChannel: WebChannel | undefined;
  if (config.channels.web.enabled) {
    webChannel = new WebChannel(eventBus);
    channelRegistry.register(webChannel);
  }

  const tg = config.channels.telegram;
  if (tg.enabled && tg.botToken) {
    logger.info({ allowedUsers: tg.allowedUserIds.length }, 'Registering Telegram channel');
    const telegramChannel = new TelegramChannel(
      tg.botToken,
      sessionManager,
      new Set(tg.allowedUserIds),
      config
    );
    channelRegistry.register(telegramChannel);
  } else if (tg.enabled) {
    logger.warn('Telegram enabled in config but channels.telegram.bot_token is not set');
  }

  const app = fastify({
    logger: createFastifyLoggerConfig(),
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(websocket);

  await registerApi(app, {
    eventBus,
    sessionManager,
    agentService,
    webChannel,
    config,
  });

  await app.register(staticFiles, {
    root: resolve(__dirname, '../static'),
    prefix: '/',
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown requested');
    await sessionManager.closeAllSessions();
    await channelRegistry.stopAll();
    db.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({
      host: config.server.host,
      port: config.server.port,
    });

    logger.info(
      {
        host: config.server.host,
        port: config.server.port,
        workspace: config.workspaceRoot,
        maxSessions: config.sdk.maxSessions,
        web: config.channels.web.enabled,
        telegram: config.channels.telegram.enabled && Boolean(config.channels.telegram.botToken),
      },
      'HTTP server listening'
    );

    const bannerTitle = `  ${APP_DISPLAY_NAME}`.padEnd(58);
    console.log(`
╔══════════════════════════════════════════════════════════╗
║${bannerTitle}║
╠══════════════════════════════════════════════════════════╣
║  Server: http://${config.server.host}:${config.server.port}                          ║
║  Workspace: ${config.workspaceRoot}              ║
║  Max Sessions: ${config.sdk.maxSessions}                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
  } catch (err) {
    logger.error({ err }, 'Failed to start HTTP server');
    process.exit(1);
  }

  void channelRegistry.startAll().catch((err) => {
    logger.error({ err }, 'Channel startup failed');
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
