import type { FastifyBaseLogger } from 'fastify';
import { runJob, type WorkerDeps } from './handlers.js';
import { claimNext } from './queue.js';

/**
 * Polling worker. Runs in-process by default (simple deploys); set WORKER_ENABLED=false
 * on API replicas and run `src/worker.ts` separately to scale workers independently.
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly log: Pick<FastifyBaseLogger, 'error'>,
    private readonly pollMs = 1000,
  ) {}

  start() {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drain();
      } catch (err) {
        this.log.error({ err }, 'worker tick failed');
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }

  /** Processes every job that is ready now. Returns the number processed. */
  async drain(max = 500): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      for (; n < max; n++) {
        const job = await claimNext(this.deps.db);
        if (!job) break;
        await runJob(this.deps, job);
      }
    } finally {
      this.running = false;
    }
    return n;
  }
}
