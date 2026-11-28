/**
 * Tests for Telegram resilience helpers (launch retry).
 */

import { describe, it, expect, vi } from 'vitest';
import { runWithRetry } from './telegram-resilience.js';

describe('runWithRetry', () => {
  it('retries after failures then resets the backoff on success', async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    let calls = 0;
    let stopping = false;

    await runWithRetry(
      async (resetBackoff) => {
        calls += 1;
        if (calls <= 2) {
          throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
        }
        resetBackoff();
        // Simulate polling that later dies once, then a clean stop.
        if (calls === 3) {
          return;
        }
        stopping = true;
      },
      {
        isStopping: () => stopping,
        sleep,
        baseMs: 2_000,
        maxMs: 60_000,
      }
    );

    expect(calls).toBe(4);
    // Failures 1 and 2 → 2s, 4s; unexpected stop after success → back to 2s
    expect(sleeps).toEqual([2_000, 4_000, 2_000]);
  });

  it('caps the delay at maxMs', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    let stopping = false;

    await runWithRetry(
      async () => {
        calls += 1;
        if (calls >= 6) stopping = true;
        throw new Error('still down');
      },
      {
        isStopping: () => stopping,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        baseMs: 2_000,
        maxMs: 8_000,
      }
    );

    expect(sleeps).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it('stops without further runs when isStopping is already true', async () => {
    const run = vi.fn(async () => {
      throw new Error('should not run');
    });
    await runWithRetry(run, {
      isStopping: () => true,
      sleep: async () => undefined,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not sleep after a reject if stop was requested during the attempt', async () => {
    const sleeps: number[] = [];
    let stopping = false;
    let calls = 0;

    await runWithRetry(
      async () => {
        calls += 1;
        stopping = true;
        throw new Error('cancelled mid-launch');
      },
      {
        isStopping: () => stopping,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }
    );

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('calls onRetry with the error, delay and attempt number', async () => {
    const events: Array<{ message: string; delayMs: number; attempt: number }> = [];
    let calls = 0;
    let stopping = false;

    await runWithRetry(
      async () => {
        calls += 1;
        if (calls >= 3) {
          stopping = true;
          return;
        }
        throw new Error(`fail-${calls}`);
      },
      {
        isStopping: () => stopping,
        sleep: async () => undefined,
        baseMs: 100,
        maxMs: 400,
        onRetry: (err, delayMs, attempt) => {
          events.push({
            message: err instanceof Error ? err.message : String(err),
            delayMs,
            attempt,
          });
        },
      }
    );

    expect(events).toEqual([
      { message: 'fail-1', delayMs: 100, attempt: 1 },
      { message: 'fail-2', delayMs: 200, attempt: 2 },
    ]);
  });
});
