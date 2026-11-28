/**
 * Telegraf resilience helpers — keep polling alive when handlers fail.
 */

import type { Context } from 'telegraf';
import type { Update } from 'telegraf/types';

/** Default Telegraf handlerTimeout is 90s; agent runs often exceed that. */
export const TELEGRAM_HANDLER_TIMEOUT_MS = 3_600_000;

export function formatTelegramError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export async function replySafe(ctx: Context<Update>, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (replyErr) {
    console.error('Failed to send Telegram reply:', replyErr);
  }
}

export interface RunWithRetryOptions {
  isStopping: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, delayMs: number, attempt: number) => void;
  /** First wait after a failure (default 2000). Doubles each time up to maxMs. */
  baseMs?: number;
  /** Cap on the wait between attempts (default 60000). */
  maxMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Keep calling `run` until `isStopping()` is true.
 *
 * `run` receives `resetBackoff`, which should be called when the long-running
 * work has actually started (e.g. Telegraf's onLaunch after getMe). A reject
 * or a resolve while not stopping (polling died) waits with exponential
 * backoff: 2s → 4s → … → 60s, then forever at 60s.
 */
export async function runWithRetry(
  run: (resetBackoff: () => void) => Promise<void>,
  opts: RunWithRetryOptions
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const baseMs = opts.baseMs ?? 2_000;
  const maxMs = opts.maxMs ?? 60_000;
  let delayMs = baseMs;
  let attempt = 0;

  const resetBackoff = () => {
    delayMs = baseMs;
  };

  while (!opts.isStopping()) {
    try {
      await run(resetBackoff);
      if (opts.isStopping()) return;
      attempt += 1;
      opts.onRetry?.(new Error('polling stopped unexpectedly'), delayMs, attempt);
    } catch (err) {
      if (opts.isStopping()) return;
      attempt += 1;
      opts.onRetry?.(err, delayMs, attempt);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, maxMs);
  }
}

/**
 * Wrap a Telegraf handler so errors are logged and the user gets feedback
 * instead of becoming an unhandled rejection that can break polling.
 */
export function wrapTelegramHandler(
  name: string,
  handler: (ctx: Context<Update>) => Promise<void>
): (ctx: Context<Update>) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error(`Telegram handler "${name}" failed:`, err);
      await replySafe(ctx, `❌ Error: ${formatTelegramError(err)}`);
    }
  };
}
