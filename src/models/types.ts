/**
 * Core domain types for Cursor Control Plane + CLI
 */

export type SessionStatus = 'open' | 'closed';
export type AgentActivity = 'idle' | 'connecting' | 'running' | 'waiting_user' | 'error';

export interface Session {
  id: string;
  channel: string;
  channelKey: string;
  repoPath: string;
  repoName: string;
  title: string;
  status: SessionStatus;
  activity: AgentActivity;
  model: string | null;
  /** Cursor SDK agent id (`agent-…` local, `bc-…` cloud) for Agent.resume after restart */
  sdkAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  errorMessage: string | null;
  outputPreview: string;
}

export interface SessionMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface SessionParticipant {
  sessionId: string;
  channel: string;
  conversationId: string;
  joinedAt: string;
}

export interface MessageTarget {
  sessionId: string;
  conversationId: string;
}

export interface IncomingMessage {
  conversationId: string;
  channel: string;
  text: string;
  repoPath?: string;
}

export interface RepoEntry {
  name: string;
  path: string;
  description: string;
}

export interface ChannelConfig {
  enabled: boolean;
}

export interface TelegramChannelConfig extends ChannelConfig {
  botToken: string;
  allowedUserIds: number[];
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface SdkConfig {
  defaultModel: string;
  maxSessions: number;
}

/** null = default daily log file; empty string = disabled; otherwise custom base path */
export type LogFileSetting = string | null;

export interface LoggingConfig {
  level: string;
  file: LogFileSetting;
}

export interface CliBridgeConfig {
  enabled: boolean;
  agentBin: string;
  chatsRoot: string;
  force: boolean;
  trust: boolean;
  /** When true, /cli lists only chats under workspaceRoot */
  filterByWorkspaceRoot: boolean;
  timeoutMs: number;
  /** Throttle interval for live Telegram message edits during CLI runs */
  streamEditIntervalMs: number;
  /**
   * When true (default), after streaming via edits the preview message is deleted
   * and the final reply is sent as a new message so Telegram can notify.
   */
  notifyOnComplete: boolean;
}

export interface AppConfig {
  cursorApiKey: string;
  repos: RepoEntry[];
  workspaceRoot: string;
  channels: {
    telegram: TelegramChannelConfig;
    web: ChannelConfig;
  };
  server: ServerConfig;
  sdk: SdkConfig;
  logging: LoggingConfig;
  cliBridge: CliBridgeConfig;
}

export type EventType =
  | 'session_updated'
  | 'session_closed'
  | 'session_removed'
  | 'sessions_purged'
  | 'agent_stream'
  | 'channel_message'
  | 'question'
  | 'hello'
  | 'pong';

export interface AppEvent {
  type: EventType;
  [key: string]: unknown;
}
