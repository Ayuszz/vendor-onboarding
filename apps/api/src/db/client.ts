import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

/**
 * Minimal database port. Both drivers speak real Postgres SQL, so the same queries
 * run against an embedded PGlite (local dev, tests — zero setup) and a real
 * Postgres server (staging/production) selected purely by DATABASE_URL.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a multi-statement script without parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pglite' | 'pg';
}

export async function createDb(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  if (opts.databaseUrl) return createPgDb(opts.databaseUrl);
  return createPgliteDb(opts.pgliteDir ?? 'memory://');
}

async function createPgliteDb(dir: string): Promise<Db> {
  // A fresh checkout has no .data folder yet; create the parent so the first start just works.
  if (!dir.startsWith('memory://')) mkdirSync(dirname(dir), { recursive: true });
  const client = new PGlite(dir);
  await client.waitReady;
  // PGlite is single-connection; serialize transactions so they never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    driver: 'pglite',
    query: async <T>(sql: string, params: unknown[] = []) => {
      const r = await client.query<T>(sql, params);
      return { rows: r.rows };
    },
    exec: async (sql: string) => {
      await client.exec(sql);
    },
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) => {
      const run = chain.then(() =>
        client.transaction(async (tx) =>
          fn({
            query: async <R>(sql: string, params: unknown[] = []) => {
              const r = await tx.query<R>(sql, params);
              return { rows: r.rows };
            },
            exec: async (sql: string) => {
              await tx.exec(sql);
            },
          }),
        ),
      );
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    },
    close: () => client.close(),
  };
}

function createPgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    driver: 'pg',
    query: async <T>(sql: string, params: unknown[] = []) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    exec: async (sql: string) => {
      await pool.query(sql);
    },
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const out = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const r = await conn.query(sql, params);
            return { rows: r.rows as R[] };
          },
          exec: async (sql: string) => {
            await conn.query(sql);
          },
        });
        await conn.query('COMMIT');
        return out;
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}
