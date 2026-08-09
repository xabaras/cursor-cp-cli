/**
 * `cursor-cp setup` — friendly onboarding wizard.
 *
 * Collects settings and writes overrides to config.yaml.
 */

import * as readline from 'node:readline';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import yaml from 'js-yaml';
import { userConfigPath } from '../config/home.js';
import { loadConfig, ensureUserConfig } from '../config/loader.js';
import { ensureProjectDirs, projectHomeDir } from '../paths.js';
import { ServiceController } from '../service/service-control.js';

const API_KEY_HELP = 'https://cursor.com/dashboard/cloud-agents';

export interface SetupValues {
  apiKey: string;
  defaultModel: string;
  host: string;
  port: number;
  logLevel: string;
  telegram: {
    enabled: boolean;
    token: string;
    allowedIds: string;
  };
}

export function validateApiKey(key: string): { ok: boolean } {
  const trimmed = key.trim();
  if (!trimmed || trimmed.startsWith('your_')) {
    return { ok: false };
  }
  return { ok: true };
}

export function parseAllowedUserIds(raw: string): number[] {
  const ids = new Set<number>();
  for (const part of raw.split(/[\s,]+/)) {
    const num = Number.parseInt(part, 10);
    if (!Number.isNaN(num)) {
      ids.add(num);
    }
  }
  return [...ids];
}

/** Build the full config object written to config.yaml. */
export function buildConfigObject(
  existing: Record<string, unknown> | undefined,
  values: SetupValues
): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const existingChannels = (base.channels ?? {}) as Record<string, Record<string, unknown>>;
  const existingSdk = (base.sdk ?? {}) as Record<string, unknown>;
  const existingLogging = (base.logging ?? {}) as Record<string, unknown>;

  return {
    ...base,
    cursor: { api_key: values.apiKey },
    repos: base.repos ?? [],
    workspace_root: base.workspace_root,
    cli_bridge: base.cli_bridge,
    channels: {
      telegram: {
        enabled: values.telegram.enabled,
        bot_token: values.telegram.enabled ? values.telegram.token : '',
        allowed_user_ids: values.telegram.enabled
          ? parseAllowedUserIds(values.telegram.allowedIds)
          : [],
      },
      web: { enabled: existingChannels.web?.enabled ?? true },
    },
    server: {
      host: values.host,
      port: values.port,
    },
    sdk: {
      default_model: values.defaultModel,
      max_sessions: existingSdk.max_sessions ?? 5,
    },
    logging: {
      level: values.logLevel || existingLogging.level || 'info',
      ...(existingLogging.file !== undefined ? { file: existingLogging.file } : {}),
    },
  };
}

function writeConfigFile(values: SetupValues): string {
  const target = userConfigPath();
  ensureUserConfig(target);
  let existing: Record<string, unknown> | undefined;
  if (existsSync(target)) {
    try {
      existing = yaml.load(readFileSync(target, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = undefined;
    }
  }
  const merged = buildConfigObject(existing, values);
  const header = [
    '# Cursor Control Plane — edit this file, then restart:',
    '#   cursor-cp daemon restart   (background)',
    '#   cursor-cp                    (foreground)',
    '',
  ].join('\n');
  writeFileSync(target, header + yaml.dump(merged, { lineWidth: 100 }));
  try {
    chmodSync(target, 0o600);
  } catch {
    // Permission bits are best-effort (e.g. on Windows).
  }
  return target;
}

class Prompter {
  private rl: readline.Interface;
  private muted = false;

  constructor() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this.rl = rl;

    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (this.muted) return;
      process.stdout.write(s);
    };
  }

  async ask(query: string): Promise<string> {
    const answer = await new Promise<string>((resolve) => this.rl.question(query, resolve));
    return answer.trim();
  }

  async askSecret(query: string): Promise<string> {
    const answer = await new Promise<string>((resolve) => {
      this.rl.question(query, (value) => {
        this.muted = false;
        process.stdout.write('\n');
        resolve(value);
      });
      this.muted = true;
    });
    return answer.trim();
  }

  async confirm(query: string, defaultYes: boolean): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await this.ask(`${query} (${hint}) `)).toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  }

  close(): void {
    this.rl.close();
  }
}

interface Existing {
  apiKey: string;
  defaultModel: string;
  host: string;
  port: number;
  logLevel: string;
  telegramToken: string;
  allowedIds: string;
  telegramEnabled: boolean;
}

function readExisting(): Existing {
  const { config } = loadConfig();
  const ids = config.channels.telegram.allowedUserIds;

  return {
    apiKey: config.cursorApiKey,
    defaultModel: config.sdk.defaultModel,
    host: config.server.host,
    port: config.server.port,
    logLevel: config.logging.level,
    telegramToken: config.channels.telegram.botToken,
    allowedIds: ids.length > 0 ? ids.join(',') : '',
    telegramEnabled: config.channels.telegram.enabled,
  };
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 7)}…${key.slice(-3)}`;
}

async function runInteractive(prompter: Prompter, existing: Existing): Promise<SetupValues> {
  console.log('');
  console.log('Welcome to Cursor Control Plane setup.');
  console.log('Press Enter to accept the [default] shown in brackets.');
  console.log('');

  let apiKey = existing.apiKey;
  while (true) {
    const hint = apiKey ? ` [keep current: ${maskKey(apiKey)}]` : '';
    const entered = await prompter.askSecret(`Cursor API key${hint}: `);
    if (!entered) break;
    const result = validateApiKey(entered);
    if (!result.ok) {
      console.log(`  Invalid or placeholder key. Get one at ${API_KEY_HELP}`);
      continue;
    }
    apiKey = entered;
    break;
  }
  if (!validateApiKey(apiKey).ok) {
    console.log(`  Warning: no API key configured. Set cursor.api_key in ${userConfigPath()} or re-run setup.`);
  }

  const defaultModel =
    (await prompter.ask(`Default model [${existing.defaultModel}]: `)) || existing.defaultModel;

  const host = (await prompter.ask(`Server host [${existing.host}]: `)) || existing.host;
  let port = existing.port;
  while (true) {
    const entered = await prompter.ask(`Server port [${existing.port}]: `);
    if (!entered) break;
    const parsed = Number.parseInt(entered, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
      break;
    }
    console.log('  Enter a valid port (1-65535).');
  }

  const telegram = { enabled: false, token: existing.telegramToken, allowedIds: existing.allowedIds };
  telegram.enabled = await prompter.confirm('Enable the Telegram bot?', existing.telegramEnabled);
  if (telegram.enabled) {
    while (true) {
      const hint = telegram.token ? ` [keep current: ${maskKey(telegram.token)}]` : '';
      const entered = await prompter.askSecret(`Telegram bot token${hint}: `);
      if (!entered && telegram.token) break;
      if (entered) {
        telegram.token = entered;
        break;
      }
      console.log('  A bot token is required to enable Telegram (get one from @BotFather).');
    }

    const idsHint = telegram.allowedIds ? ` [${telegram.allowedIds}]` : '';
    const ids =
      (await prompter.ask(`Allowed Telegram user IDs (comma-separated)${idsHint}: `)) ||
      telegram.allowedIds;
    const parsed = parseAllowedUserIds(ids);
    if (parsed.length === 0) {
      console.log('  Warning: no valid user IDs — the bot will reject everyone until you set them.');
    }
    telegram.allowedIds = parsed.join(',');
  }

  return { apiKey, defaultModel, host, port, logLevel: existing.logLevel, telegram };
}

function resolveNonInteractive(existing: Existing): SetupValues {
  const result = validateApiKey(existing.apiKey);
  if (!result.ok) {
    console.error('Error: cursor.api_key is required for non-interactive setup.');
    console.error(`Set cursor.api_key in ${userConfigPath()} and re-run. Get a key at ${API_KEY_HELP}`);
    process.exit(1);
  }

  const telegramEnabled = existing.telegramEnabled || Boolean(existing.telegramToken);
  return {
    apiKey: existing.apiKey,
    defaultModel: existing.defaultModel,
    host: existing.host,
    port: existing.port,
    logLevel: existing.logLevel,
    telegram: {
      enabled: telegramEnabled,
      token: existing.telegramToken,
      allowedIds: parseAllowedUserIds(existing.allowedIds).join(','),
    },
  };
}

async function maybeEnableDaemon(prompter: Prompter | null, autoEnable: boolean): Promise<void> {
  let enable = autoEnable;
  if (prompter && !autoEnable) {
    enable = await prompter.confirm(
      'Run cursor-cp in the background on login (enable daemon)?',
      false
    );
  }
  if (!enable) return;

  try {
    await new ServiceController().install();
  } catch (err) {
    console.error(`Could not enable daemon: ${err instanceof Error ? err.message : String(err)}`);
    console.error('You can start it manually any time with: cursor-cp');
    console.error('Or enable later with: cursor-cp daemon enable');
  }
}

export interface SetupOptions {
  nonInteractive?: boolean;
  enableDaemon?: boolean;
  noDaemon?: boolean;
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (const arg of args) {
    switch (arg) {
      case '--non-interactive':
      case '--yes':
      case '-y':
        options.nonInteractive = true;
        break;
      case '--enable-daemon':
        options.enableDaemon = true;
        break;
      case '--no-daemon':
        options.noDaemon = true;
        break;
      default:
        break;
    }
  }
  return options;
}

export async function runSetup(args: string[] = []): Promise<void> {
  const options = parseSetupArgs(args);
  const interactive = Boolean(process.stdin.isTTY) && !options.nonInteractive;

  ensureProjectDirs();
  ensureUserConfig();
  const existing = readExisting();

  let values: SetupValues;
  let prompter: Prompter | null = null;

  if (interactive) {
    prompter = new Prompter();
    try {
      values = await runInteractive(prompter, existing);
    } catch (err) {
      prompter.close();
      throw err;
    }
  } else {
    values = resolveNonInteractive(existing);
  }

  const configPath = writeConfigFile(values);

  console.log('');
  console.log('Configuration saved:');
  console.log(`  ${configPath}`);

  if (!options.noDaemon) {
    await maybeEnableDaemon(prompter, Boolean(options.enableDaemon));
  }

  prompter?.close();

  console.log('');
  console.log('Setup complete.');
  console.log(`  Edit config:        ${configPath}`);
  console.log(`  Start the server:   cursor-cp`);
  console.log(`  Open in a browser:  http://localhost:${values.port}`);
  console.log(`  Check your setup:   cursor-cp doctor`);
  console.log(`  Data directory:     ${projectHomeDir()}`);
  console.log('');
}
