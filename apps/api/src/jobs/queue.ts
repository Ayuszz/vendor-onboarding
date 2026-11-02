import type { Db, Queryable } from '../db/client.js';

/**
 * Postgres-backed job queue (transactional outbox).
 *
 * - `enqueue` takes the caller's transaction, so a job exists iff the state change
 *   that needs it committed.
 * - Workers claim with `FOR UPDATE SKIP LOCKED`: many workers, no double processing.
 * - Failures back off exponentially; jobs stuck in "running" (crashed worker) are
 *   reclaimed after a lease timeout.
 */

export type JobType = 'verify_document' | 'sap_sync';

export interface Job<P = Record<string, unknown>> {
  id: number;
  type: JobType;
  payload: P;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  dedupeKey?: string;
  maxAttempts?: number;
  delayMs?: number;
}

export async function enqueue(tx: Queryable, type: JobType, payload: object, opts: EnqueueOptions = {}) {
  await tx.query(
    `INSERT INTO jobs (type, payload, max_attempts, run_at, dedupe_key)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval, $5)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING`,
    [type, JSON.stringify(payload), opts.maxAttempts ?? 5, String(opts.delayMs ?? 0), opts.dedupeKey ?? null],
  );
}

const LEASE_SECONDS = 300;

export async function claimNext(db: Db): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE (status = 'queued' AND run_at <= now())
          OR (status = 'running' AND locked_at < now() - interval '${LEASE_SECONDS} seconds')
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, type, payload, attempts, max_attempts`,
  );
  return rows[0] ?? null;
}

export async function complete(db: Queryable, id: number) {
  await db.query(`UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1`, [id]);
}

/** Backoff: 2s, 4s, 8s … capped at 5 min, plus jitter so retries don't stampede. */
export function backoffMs(attempt: number, baseMs = 2000) {
  const exp = Math.min(baseMs * 2 ** (attempt - 1), 300_000);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/** Returns true if the job will be retried, false if it is now permanently failed. */
export async function fail(db: Queryable, job: Job, error: string, retryable: boolean, baseMs?: number) {
  const willRetry = retryable && job.attempts < job.max_attempts;
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, updated_at = now(),
       run_at = now() + ($4 || ' milliseconds')::interval
     WHERE id = $1`,
    [job.id, willRetry ? 'queued' : 'failed', error.slice(0, 2000), String(willRetry ? backoffMs(job.attempts, baseMs) : 0)],
  );
  return willRetry;
}
