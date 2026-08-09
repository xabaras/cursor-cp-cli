/**
 * Per-Telegram-chat FIFO queue for CLI print jobs.
 */

export interface CliQueuedJob<TPayload> {
  id: number;
  payload: TPayload;
}

export class CliJobQueue<TPayload> {
  private queues = new Map<string, CliQueuedJob<TPayload>[]>();
  private running = new Set<string>();
  private nextId = 1;
  private processors = new Map<string, (job: CliQueuedJob<TPayload>) => Promise<void>>();

  /** Register the async worker for a telegram chat key (idempotent replace). */
  setProcessor(key: string, processor: (job: CliQueuedJob<TPayload>) => Promise<void>): void {
    this.processors.set(key, processor);
  }

  enqueue(key: string, payload: TPayload): { jobId: number; position: number } {
    const q = this.queues.get(key) ?? [];
    const job: CliQueuedJob<TPayload> = { id: this.nextId++, payload };
    q.push(job);
    this.queues.set(key, q);
    const position = q.length;
    void this.pump(key);
    return { jobId: job.id, position };
  }

  clear(key: string): number {
    const q = this.queues.get(key) ?? [];
    const n = q.length;
    this.queues.set(key, []);
    return n;
  }

  pendingCount(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  private async pump(key: string): Promise<void> {
    if (this.running.has(key)) return;
    const processor = this.processors.get(key);
    if (!processor) return;

    this.running.add(key);
    try {
      while (true) {
        const q = this.queues.get(key) ?? [];
        const job = q.shift();
        this.queues.set(key, q);
        if (!job) break;
        await processor(job);
      }
    } finally {
      this.running.delete(key);
      // If something enqueued during the final stretch, pump again
      if ((this.queues.get(key)?.length ?? 0) > 0) {
        void this.pump(key);
      }
    }
  }
}
