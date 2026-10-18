/**
 * Configuration loader — config.default.yaml + config.yaml overrides.
 */

import { readFileSync, existsSync, copyFileSync, mkdirSync, chmodSync } from 'fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  configDefaultPath,
  projectConfigPath,
  userConfigPath,
  expandHome,
  defaultWorkspaceRoot,
  projectHomeDir,
} from './home.js';
import type { AppConfig, LogFileSetting } from '../models/types.js';

const RepoEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().default(''),
});

export const RawConfigSchema = z.object({
  cursor: z.object({
    api_key: z.string().default(''),
  }).default({ api_key: '' }),
  repos: z.array(RepoEntrySchema).default([]),
  workspace_root: z.string().default(''),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(''),
      allowed_user_ids: z.array(z.union([z.number(), z.string()])).default([]),
    }).default({ enabled: false, bot_token: '', allowed_user_ids: [] }),
    web: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  }).default({
    telegram: { enabled: false, bot_token: '', allowed_user_ids: [] },
    web: { enabled: true },
  }),
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().default(8747),
  }).default({ host: '0.0.0.0', port: 8747 }),
  sdk: z.object({
    default_model: z.string().default('composer-2.5'),
    max_sessions: z.number().default(5),
  }).default({ default_model: 'composer-2.5', max_sessions: 5 }),
  logging: z.object({
    level: z.string().default('info'),
    file: z.union([z.string(), z.boolean(), z.null()]).optional(),
  }).default({ level: 'info' }),
  cli_bridge: z
    .object({
      enabled: z.boolean().default(false),
      agent_bin: z.string().default('agent'),
      chats_root: z.string().default('~/.cursor/chats'),
      force: z.boolean().default(true),
      trust: z.boolean().default(true),
      filter_by_workspace_root: z.boolean().default(true),
      timeout_ms: z.number().default(600_000),
      stream_edit_interval_ms: z.number().default(1200),
      notify_on_complete: z.boolean().default(true),
    })
    .default({
      enabled: false,
      agent_bin: 'agent',
      chats_root: '~/.cursor/chats',
      force: true,
      trust: true,
      filter_by_workspace_root: true,
      timeout_ms: 600_000,
      stream_edit_interval_ms: 1200,
      notify_on_complete: true,
    }),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

let cachedConfig: AppConfig | null = null;

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function getLoadedConfig(): AppConfig | null {
  return cachedConfig;
}

export function parseAllowedUserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<number>();
  for (const part of raw) {
    const num = typeof part === 'number' ? part : Number.parseInt(String(part), 10);
    if (!Number.isNaN(num)) ids.add(num);
  }
  return [...ids];
}

/** Deep-merge override into base (objects merge; arrays and scalars replace). */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function readYamlFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveLogFileSetting(raw: string | boolean | null | undefined): LogFileSetting {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw ? null : '';
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === '0' || trimmed.toLowerCase() === 'false') return '';
  return trimmed;
}

function resolveWorkspaceRoot(raw: RawConfig): string {
  const fromConfig = raw.workspace_root?.trim();
  if (fromConfig) return expandHome(fromConfig);
  return defaultWorkspaceRoot();
}

function rawToAppConfig(raw: RawConfig): AppConfig {
  return {
    cursorApiKey: raw.cursor.api_key.trim(),
    repos: raw.repos,
    workspaceRoot: resolveWorkspaceRoot(raw),
    channels: {
      telegram: {
        enabled: raw.channels.telegram.enabled,
        botToken: raw.channels.telegram.bot_token.trim(),
        allowedUserIds: parseAllowedUserIds(raw.channels.telegram.allowed_user_ids),
      },
      web: { enabled: raw.channels.web.enabled },
    },
    server: {
      host: raw.server.host,
      port: raw.server.port,
    },
    sdk: {
      defaultModel: raw.sdk.default_model,
      maxSessions: raw.sdk.max_sessions,
    },
    logging: {
      level: raw.logging.level,
      file: resolveLogFileSetting(raw.logging.file),
    },
    cliBridge: {
      enabled: raw.cli_bridge.enabled,
      agentBin: raw.cli_bridge.agent_bin.trim() || 'agent',
      chatsRoot: expandHome(raw.cli_bridge.chats_root || '~/.cursor/chats'),
      force: raw.cli_bridge.force,
      trust: raw.cli_bridge.trust,
      filterByWorkspaceRoot: raw.cli_bridge.filter_by_workspace_root,
      timeoutMs: raw.cli_bridge.timeout_ms,
      streamEditIntervalMs: raw.cli_bridge.stream_edit_interval_ms,
      notifyOnComplete: raw.cli_bridge.notify_on_complete,
    },
  };
}

/** Load and merge config from explicit paths (used by tests). */
export function loadConfigFromPaths(
  defaultPath: string,
  overridePaths: string[] = []
): { config: AppConfig; defaultPath: string; overridePaths: string[] } {
  let merged: Record<string, unknown> = readYamlFile(defaultPath) ?? {};

  const appliedOverrides: string[] = [];
  for (const path of overridePaths) {
    const layer = readYamlFile(path);
    if (layer) {
      merged = deepMerge(merged, layer);
      appliedOverrides.push(path);
    }
  }

  const config = rawToAppConfig(RawConfigSchema.parse(merged));
  cachedConfig = config;

  return { config, defaultPath, overridePaths: appliedOverrides };
}

function collectOverridePaths(): string[] {
  const paths: string[] = [];
  const home = userConfigPath();
  const project = projectConfigPath();
  if (existsSync(home)) paths.push(home);
  if (project !== home && existsSync(project)) paths.push(project);
  return paths;
}

export function loadConfig(): {
  config: AppConfig;
  defaultPath: string;
  overridePaths: string[];
} {
  const defaultPath = configDefaultPath();
  return loadConfigFromPaths(defaultPath, collectOverridePaths());
}

/** Create config.yaml from config.default.yaml when missing. */
export function ensureUserConfig(targetPath = userConfigPath()): string {
  if (existsSync(targetPath)) {
    return targetPath;
  }

  const defaults = configDefaultPath();
  if (!existsSync(defaults)) {
    throw new Error(`Missing defaults file: ${defaults}`);
  }

  mkdirSync(projectHomeDir(), { recursive: true });
  copyFileSync(defaults, targetPath);
  try {
    chmodSync(targetPath, 0o600);
  } catch {
    // Best-effort on Windows.
  }
  return targetPath;
}

/** Create project-root config.yaml for local development. */
export function ensureProjectConfig(): string {
  return ensureUserConfig(projectConfigPath());
}

export function requireCursorApiKey(config: AppConfig): string {
  const apiKey = config.cursorApiKey.trim();
  if (!apiKey || apiKey.startsWith('your_')) {
    console.error('Error: cursor.api_key is required.');
    console.error('');
    console.error('Run the setup wizard:');
    console.error('  cursor-cp setup');
    console.error('');
    console.error(`Or set cursor.api_key in ${userConfigPath()}`);
    console.error('Get a key from: https://cursor.com/dashboard/cloud-agents');
    process.exit(1);
  }
  return apiKey;
}
