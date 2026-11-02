import type { Db } from './client.js';

/**
 * Forward-only, versioned migrations. Each runs once, inside a transaction, and is
 * recorded in schema_migrations. Never edit a shipped migration — add a new one.
 */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'init',
    sql: /* sql */ `
      CREATE TABLE users (
        id          text PRIMARY KEY,
        name        text NOT NULL,
        email       text NOT NULL UNIQUE,
        roles       text[] NOT NULL DEFAULT '{}',
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE SEQUENCE vendor_ref_seq START 1001;
      CREATE SEQUENCE sap_card_code_seq START 10001;

      CREATE TABLE vendors (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reference     text NOT NULL UNIQUE,
        state         text NOT NULL,
        profile       jsonb NOT NULL DEFAULT '{}',
        approvals     jsonb NOT NULL DEFAULT '[]',
        created_by    text NOT NULL REFERENCES users(id),
        version       integer NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        submitted_at  timestamptz,
        onboarded_at  timestamptz
      );
      CREATE INDEX vendors_state_idx ON vendors(state);
      CREATE INDEX vendors_created_by_idx ON vendors(created_by);
      CREATE INDEX vendors_updated_idx ON vendors(updated_at DESC);

      CREATE TABLE vendor_documents (
        vendor_id    uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
        doc_key      text NOT NULL,
        status       text NOT NULL,
        fields       jsonb NOT NULL DEFAULT '{}',
        reasons      jsonb NOT NULL DEFAULT '[]',
        derived      jsonb NOT NULL DEFAULT '{}',
        file_key     text,
        file_name    text,
        file_size    integer,
        mime_type    text,
        sha256       text,
        revision     integer NOT NULL DEFAULT 1,
        uploaded_at  timestamptz NOT NULL DEFAULT now(),
        verified_at  timestamptz,
        PRIMARY KEY (vendor_id, doc_key)
      );

      -- Append-only audit trail: who did what, when, and the state change it caused.
      CREATE TABLE vendor_events (
        id          bigserial PRIMARY KEY,
        vendor_id   uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
        action      text NOT NULL,
        from_state  text,
        to_state    text,
        actor_id    text REFERENCES users(id),
        actor_name  text NOT NULL,
        role        text,
        reason      text,
        detail      jsonb,
        at          timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX vendor_events_vendor_idx ON vendor_events(vendor_id, id);

      -- One SAP record per vendor. The card code is allocated once and reused on every
      -- retry, which (with the idempotency key) makes the SAP call safe to repeat.
      CREATE TABLE sap_sync (
        vendor_id        uuid PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
        status           text NOT NULL,
        card_code        text NOT NULL UNIQUE,
        idempotency_key  text NOT NULL UNIQUE,
        attempts         integer NOT NULL DEFAULT 0,
        last_error       text,
        synced_at        timestamptz,
        updated_at       timestamptz NOT NULL DEFAULT now()
      );

      -- Transactional outbox / job queue. Jobs are inserted in the same transaction as
      -- the state change that requires them, so work is never lost or duplicated.
      CREATE TABLE jobs (
        id            bigserial PRIMARY KEY,
        type          text NOT NULL,
        payload       jsonb NOT NULL,
        status        text NOT NULL DEFAULT 'queued',
        attempts      integer NOT NULL DEFAULT 0,
        max_attempts  integer NOT NULL DEFAULT 5,
        run_at        timestamptz NOT NULL DEFAULT now(),
        locked_at     timestamptz,
        last_error    text,
        dedupe_key    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX jobs_ready_idx ON jobs(run_at) WHERE status = 'queued';
      CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs(dedupe_key) WHERE status IN ('queued', 'running');
    `,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ id: number }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    });
    ran.push(m.id);
  }
  return ran;
}
