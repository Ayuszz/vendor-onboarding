import {
  DOCUMENTS,
  DOCUMENT_KEYS,
  STATE_META,
  availableActions,
  decide,
  mergeDraft,
  pendingWith,
  requiredDocumentKeys,
  sanitizeDocFields,
  submissionBlockers,
  vendorDraftSchema,
  type ActionBody,
  type Approval,
  type DocStatus,
  type DocumentDTO,
  type DocumentKey,
  type EventDTO,
  type Paged,
  type Role,
  type SapDTO,
  type State,
  type StatsDTO,
  type UserAction,
  type UserDTO,
  type VendorDTO,
  type VendorDraft,
  type VendorListItem,
} from '@vo/shared';
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/client.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { enqueue } from '../jobs/queue.js';
import type { FileStorage } from '../storage.js';

export interface Deps {
  db: Db;
  storage: FileStorage;
  cfg: Config;
}

interface VendorRow {
  id: string;
  reference: string;
  state: State;
  profile: VendorDraft;
  approvals: Approval[];
  created_by: string;
  vendor_user_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DocRow {
  doc_key: DocumentKey;
  status: DocStatus;
  fields: Record<string, string>;
  reasons: string[];
  derived: Record<string, string>;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  revision: number;
  uploaded_at: Date | string;
  verified_at: Date | string | null;
}

const REVIEWER_ROLES: Role[] = ['QC', 'SCM', 'FINANCE', 'ADMIN'];
const EDITABLE_STATES: State[] = ['DRAFT', 'SENT_BACK'];
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

const isReviewer = (u: UserDTO) => u.roles.some((r) => REVIEWER_ROLES.includes(r));
const owns = (u: UserDTO, v: VendorRow) => v.vendor_user_id === u.id || v.created_by === u.id;
const canView = (u: UserDTO, v: VendorRow) => isReviewer(u) || owns(u, v);
const canEdit = (u: UserDTO, v: VendorRow) =>
  EDITABLE_STATES.includes(v.state) &&
  (u.roles.includes('ADMIN') || (u.roles.some((r) => r === 'REQUESTER' || r === 'VENDOR') && owns(u, v)));

// ───────────────────────────── reads ─────────────────────────────

async function loadVendor(q: Queryable, id: string, lock = false): Promise<VendorRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Vendor');
  const { rows } = await q.query<VendorRow>(
    `SELECT id, reference, state, profile, approvals, created_by, vendor_user_id, version, created_at, updated_at
     FROM vendors WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('Vendor');
  return rows[0];
}

async function loadDocs(q: Queryable, vendorId: string): Promise<DocRow[]> {
  const { rows } = await q.query<DocRow>(
    `SELECT doc_key, status, fields, reasons, derived, file_key, file_name, file_size, mime_type,
            revision, uploaded_at, verified_at
     FROM vendor_documents WHERE vendor_id = $1`,
    [vendorId],
  );
  return rows.sort((a, b) => DOCUMENT_KEYS.indexOf(a.doc_key) - DOCUMENT_KEYS.indexOf(b.doc_key));
}

function blockersFor(v: VendorRow, docs: DocRow[]) {
  const map = Object.fromEntries(docs.map((d) => [d.doc_key, { status: d.status }]));
  return submissionBlockers(v.profile, map);
}

function toDocDTO(d: DocRow): DocumentDTO {
  return {
    key: d.doc_key,
    status: d.status,
    fields: d.fields,
    reasons: d.reasons,
    derived: d.derived,
    file: d.file_key ? { name: d.file_name ?? 'file', size: d.file_size ?? 0, mimeType: d.mime_type ?? '' } : null,
    uploadedAt: iso(d.uploaded_at)!,
    verifiedAt: iso(d.verified_at),
  };
}

export async function getVendor(deps: Deps, user: UserDTO, id: string): Promise<VendorDTO> {
  const v = await loadVendor(deps.db, id);
  if (!canView(user, v)) throw notFound('Vendor');
  const docs = await loadDocs(deps.db, id);
  const { rows: sapRows } = await deps.db.query<{
    status: SapDTO['status'];
    card_code: string;
    attempts: number;
    last_error: string | null;
    synced_at: Date | null;
  }>('SELECT status, card_code, attempts, last_error, synced_at FROM sap_sync WHERE vendor_id = $1', [id]);
  const sap = sapRows[0];
  const snapshot = { state: v.state, approvals: v.approvals };
  let allowed: UserAction[] = availableActions(snapshot, user.roles);
  // Requesters may only act on their own vendors.
  if (!canEdit(user, v)) allowed = allowed.filter((a) => a !== 'submit');

  return {
    id: v.id,
    reference: v.reference,
    state: v.state,
    profile: v.profile,
    approvals: v.approvals,
    documents: docs.map(toDocDTO),
    sap: sap
      ? {
          status: sap.status,
          cardCode: sap.card_code,
          attempts: sap.attempts,
          lastError: sap.last_error,
          syncedAt: iso(sap.synced_at),
        }
      : null,
    blockers: EDITABLE_STATES.includes(v.state) ? blockersFor(v, docs) : [],
    pendingWith: pendingWith(snapshot),
    allowedActions: allowed,
    createdBy: v.created_by,
    createdAt: iso(v.created_at)!,
    updatedAt: iso(v.updated_at)!,
    version: v.version,
  };
}

export interface ListQuery {
  state?: State | undefined;
  q?: string | undefined;
  queue?: boolean | undefined;
  limit: number;
  offset: number;
}

/** States in which each role has something to do. */
function queueFilter(roles: Role[]): { sql: string; params: unknown[] } | null {
  const clauses: string[] = [];
  if (roles.includes('QC')) clauses.push(`(v.state = 'IN_REVIEW' AND NOT v.approvals @> '[{"role":"QC"}]')`);
  if (roles.includes('SCM')) clauses.push(`(v.state = 'IN_REVIEW' AND NOT v.approvals @> '[{"role":"SCM"}]')`);
  if (roles.includes('FINANCE')) clauses.push(`v.state IN ('FINANCE_REVIEW', 'SAP_ERROR')`);
  if (roles.includes('ADMIN')) clauses.push(`v.state = 'SAP_ERROR'`);
  if (roles.includes('REQUESTER') || roles.includes('VENDOR')) clauses.push(`v.state IN ('DRAFT', 'SENT_BACK')`);
  return clauses.length ? { sql: `(${clauses.join(' OR ')})`, params: [] } : null;
}

export async function listVendors(deps: Deps, user: UserDTO, query: ListQuery): Promise<Paged<VendorListItem>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (!isReviewer(user)) {
    const me = p(user.id);
    where.push(`(v.created_by = ${me} OR v.vendor_user_id = ${me})`);
  }
  if (query.state) where.push(`v.state = ${p(query.state)}`);
  if (query.q) {
    const term = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
    where.push(`(v.profile->>'legalName' ILIKE ${p(term)} OR v.reference ILIKE ${p(term)})`);
  }
  if (query.queue) {
    const f = queueFilter(user.roles);
    where.push(f ? f.sql : 'false');
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: countRows } = await deps.db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM vendors v ${whereSql}`,
    params,
  );
  const { rows } = await deps.db.query<VendorRow & { uploaded: unknown }>(
    `SELECT v.id, v.reference, v.state, v.profile, v.approvals, v.updated_at,
       (SELECT coalesce(jsonb_agg(d.doc_key), '[]') FROM vendor_documents d
          WHERE d.vendor_id = v.id AND d.status = 'VERIFIED') AS uploaded
     FROM vendors v ${whereSql}
     ORDER BY v.updated_at DESC
     LIMIT ${p(query.limit)} OFFSET ${p(query.offset)}`,
    params,
  );

  return {
    total: Number(countRows[0]?.n ?? 0),
    items: rows.map((r) => {
      const required = requiredDocumentKeys(r.profile);
      const verifiedKeys = new Set(r.uploaded as string[]);
      return {
        id: r.id,
        reference: r.reference,
        legalName: r.profile.legalName || 'Untitled vendor',
        category: r.profile.category ?? null,
        state: r.state,
        pendingWith: pendingWith({ state: r.state, approvals: r.approvals }),
        docs: { verified: required.filter((k) => verifiedKeys.has(k)).length, required: required.length },
        updatedAt: iso(r.updated_at)!,
      };
    }),
  };
}

export async function listEvents(deps: Deps, user: UserDTO, id: string): Promise<EventDTO[]> {
  const v = await loadVendor(deps.db, id);
  if (!canView(user, v)) throw notFound('Vendor');
  const { rows } = await deps.db.query<{
    id: string | number;
    action: EventDTO['action'];
    from_state: State | null;
    to_state: State | null;
    actor_name: string;
    role: string | null;
    reason: string | null;
    detail: Record<string, unknown> | null;
    at: Date;
  }>(
    `SELECT id, action, from_state, to_state, actor_name, role, reason, detail, at
     FROM vendor_events WHERE vendor_id = $1 ORDER BY id`,
    [id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    fromState: r.from_state,
    toState: r.to_state,
    actorName: r.actor_name,
    role: r.role,
    reason: r.reason,
    detail: r.detail,
    at: iso(r.at)!,
  }));
}

export async function stats(deps: Deps, user: UserDTO): Promise<StatsDTO> {
  const scope = isReviewer(user) ? '' : 'WHERE (created_by = $1 OR vendor_user_id = $1)';
  const params = isReviewer(user) ? [] : [user.id];
  const { rows } = await deps.db.query<{ state: State; n: string | number }>(
    `SELECT state, count(*) AS n FROM vendors ${scope} GROUP BY state`,
    params,
  );
  const { rows: avg } = await deps.db.query<{ days: string | number | null }>(
    `SELECT avg(extract(epoch FROM (onboarded_at - submitted_at)) / 86400) AS days
     FROM vendors ${scope ? scope + ' AND' : 'WHERE'} onboarded_at IS NOT NULL`,
    params,
  );
  const queue = await listVendors(deps, user, { queue: true, limit: 1, offset: 0 });
  const days = avg[0]?.days;
  return {
    byState: Object.fromEntries(rows.map((r) => [r.state, Number(r.n)])),
    myQueue: queue.total,
    avgDaysToOnboard: days === null || days === undefined ? null : Math.round(Number(days) * 10) / 10,
  };
}

// ───────────────────────────── writes ─────────────────────────────

async function logEvent(
  q: Queryable,
  e: {
    vendorId: string;
    action: string;
    from?: State | null;
    to?: State | null;
    actor: UserDTO | null;
    role?: string | null;
    reason?: string | null;
    detail?: Record<string, unknown> | null;
  },
) {
  await q.query(
    `INSERT INTO vendor_events (vendor_id, action, from_state, to_state, actor_id, actor_name, role, reason, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.vendorId,
      e.action,
      e.from ?? null,
      e.to ?? null,
      e.actor?.id ?? null,
      e.actor?.name ?? 'System',
      e.role ?? null,
      e.reason ?? null,
      e.detail ? JSON.stringify(e.detail) : null,
    ],
  );
}

function checkVersion(v: VendorRow, version: number | undefined) {
  if (version !== undefined && version !== v.version)
    throw conflict('This vendor was changed by someone else. Refresh and try again.');
}

export async function createVendor(deps: Deps, user: UserDTO, draft: VendorDraft) {
  if (!user.roles.some((r) => r === 'REQUESTER' || r === 'VENDOR' || r === 'ADMIN'))
    throw forbidden('Only vendors and buyers can start an application');
  const isVendor = user.roles.includes('VENDOR');
  const profile = vendorDraftSchema.parse(isVendor ? { ...draft, contact: { ...draft.contact, email: user.email } } : draft);
  const id = await deps.db.transaction(async (tx) => {
    if (isVendor) {
      const { rows: mine } = await tx.query('SELECT 1 FROM vendors WHERE vendor_user_id = $1', [user.id]);
      if (mine.length) throw conflict('Your company already has an application. Open it from your home page.');
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO vendors (reference, state, profile, created_by, vendor_user_id)
       VALUES ('VO-' || to_char(now(), 'YYYY') || '-' || nextval('vendor_ref_seq'), 'DRAFT', $1, $2, $3)
       RETURNING id`,
      [JSON.stringify(profile), user.id, isVendor ? user.id : null],
    );
    const vendorId = rows[0]!.id;
    await logEvent(tx, { vendorId, action: 'created', to: 'DRAFT', actor: user, role: isVendor ? 'VENDOR' : 'REQUESTER' });
    return vendorId;
  });
  return getVendor(deps, user, id);
}

export async function updateDraft(deps: Deps, user: UserDTO, id: string, patch: VendorDraft, version?: number) {
  const clean = vendorDraftSchema.parse(patch);
  await deps.db.transaction(async (tx) => {
    const v = await loadVendor(tx, id, true);
    if (!canView(user, v)) throw notFound('Vendor');
    if (!canEdit(user, v)) throw forbidden(`Vendor cannot be edited in state ${STATE_META[v.state].label}`);
    checkVersion(v, version);
    const merged = mergeDraft(v.profile, clean);
    await tx.query(`UPDATE vendors SET profile = $2, version = version + 1, updated_at = now() WHERE id = $1`, [
      id,
      JSON.stringify(merged),
    ]);
    // Profile changes can invalidate cross-checks (e.g. bank details vs. bank proof), so re-verify.
    const docs = await loadDocs(tx, id);
    for (const d of docs) await requeueVerification(tx, id, d.doc_key);
  });
  return getVendor(deps, user, id);
}

async function requeueVerification(tx: Queryable, vendorId: string, key: DocumentKey) {
  const { rows } = await tx.query<{ revision: number }>(
    `UPDATE vendor_documents SET status = 'PENDING', revision = revision + 1, verified_at = NULL
     WHERE vendor_id = $1 AND doc_key = $2 RETURNING revision`,
    [vendorId, key],
  );
  if (rows[0])
    await enqueue(tx, 'verify_document', { vendorId, docKey: key, revision: rows[0].revision }, {
      dedupeKey: `verify:${vendorId}:${key}`,
      maxAttempts: 3,
    });
}

export interface UploadInput {
  fields: Record<string, unknown>;
  file?: { buffer: Buffer; name: string; mime: string; ext: string } | undefined;
}

export async function upsertDocument(deps: Deps, user: UserDTO, id: string, key: string, input: UploadInput) {
  if (!(DOCUMENT_KEYS as readonly string[]).includes(key)) throw badRequest(`Unknown document type "${key}"`);
  const docKey = key as DocumentKey;
  const fields = sanitizeDocFields(docKey, input.fields);

  // Store the file before the transaction (I/O outside the lock); clean up if the TX fails.
  const stored = input.file ? await deps.storage.put(input.file.buffer, input.file.ext) : null;
  let replacedKey: string | null = null;
  try {
    await deps.db.transaction(async (tx) => {
      const v = await loadVendor(tx, id, true);
      if (!canView(user, v)) throw notFound('Vendor');
      if (!canEdit(user, v)) throw forbidden('Documents can only be changed while the vendor is a draft');
      if (DOCUMENTS[docKey].requirement(v.profile) === 'hidden')
        throw unprocessable('DOCUMENT_NOT_APPLICABLE', `${DOCUMENTS[docKey].label} does not apply to this vendor`);

      const { rows: existing } = await tx.query<{ file_key: string | null }>(
        'SELECT file_key FROM vendor_documents WHERE vendor_id = $1 AND doc_key = $2',
        [id, docKey],
      );
      if (!existing[0] && !stored) throw badRequest('A file is required for the first upload');
      if (stored && existing[0]?.file_key) replacedKey = existing[0].file_key;

      const { rows } = await tx.query<{ revision: number }>(
        `INSERT INTO vendor_documents
           (vendor_id, doc_key, status, fields, reasons, derived, file_key, file_name, file_size, mime_type, sha256)
         VALUES ($1, $2, 'PENDING', $3, '[]', '{}', $4, $5, $6, $7, $8)
         ON CONFLICT (vendor_id, doc_key) DO UPDATE SET
           status = 'PENDING', fields = EXCLUDED.fields, reasons = '[]', derived = '{}',
           file_key = coalesce(EXCLUDED.file_key, vendor_documents.file_key),
           file_name = coalesce(EXCLUDED.file_name, vendor_documents.file_name),
           file_size = coalesce(EXCLUDED.file_size, vendor_documents.file_size),
           mime_type = coalesce(EXCLUDED.mime_type, vendor_documents.mime_type),
           sha256 = coalesce(EXCLUDED.sha256, vendor_documents.sha256),
           revision = vendor_documents.revision + 1, uploaded_at = now(), verified_at = NULL
         RETURNING revision`,
        [
          id,
          docKey,
          JSON.stringify(fields),
          stored?.key ?? null,
          input.file?.name.slice(0, 200) ?? null,
          input.file?.buffer.length ?? null,
          input.file?.mime ?? null,
          stored?.sha256 ?? null,
        ],
      );
      await enqueue(tx, 'verify_document', { vendorId: id, docKey, revision: rows[0]!.revision }, {
        dedupeKey: `verify:${id}:${docKey}`,
        maxAttempts: 3,
      });
      // GST is cross-checked against PAN, so a PAN change re-verifies GST.
      if (docKey === 'pan') await requeueVerification(tx, id, 'gst');
      await tx.query('UPDATE vendors SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
      await logEvent(tx, {
        vendorId: id,
        action: 'document_uploaded',
        actor: user,
        role: user.roles.includes('VENDOR') ? 'VENDOR' : 'REQUESTER',
        detail: { document: docKey, file: input.file?.name ?? null },
      });
    });
  } catch (err) {
    if (stored) await deps.storage.remove(stored.key).catch(() => undefined);
    throw err;
  }
  if (replacedKey) await deps.storage.remove(replacedKey).catch(() => undefined);
  return getVendor(deps, user, id);
}

export async function deleteDocument(deps: Deps, user: UserDTO, id: string, key: string) {
  let fileKey: string | null = null;
  await deps.db.transaction(async (tx) => {
    const v = await loadVendor(tx, id, true);
    if (!canView(user, v)) throw notFound('Vendor');
    if (!canEdit(user, v)) throw forbidden('Documents can only be changed while the vendor is a draft');
    const { rows } = await tx.query<{ file_key: string | null }>(
      'DELETE FROM vendor_documents WHERE vendor_id = $1 AND doc_key = $2 RETURNING file_key',
      [id, key],
    );
    if (!rows[0]) throw notFound('Document');
    fileKey = rows[0].file_key;
    await tx.query('UPDATE vendors SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
  });
  if (fileKey) await deps.storage.remove(fileKey).catch(() => undefined);
  return getVendor(deps, user, id);
}

export async function getDocumentFile(deps: Deps, user: UserDTO, id: string, key: string) {
  const v = await loadVendor(deps.db, id);
  if (!canView(user, v)) throw notFound('Vendor');
  const { rows } = await deps.db.query<{ file_key: string | null; file_name: string; mime_type: string }>(
    'SELECT file_key, file_name, mime_type FROM vendor_documents WHERE vendor_id = $1 AND doc_key = $2',
    [id, key],
  );
  const row = rows[0];
  if (!row?.file_key) throw notFound('File');
  return { stream: deps.storage.read(row.file_key), name: row.file_name, mime: row.mime_type };
}

export async function performAction(deps: Deps, user: UserDTO, id: string, action: UserAction, body: ActionBody) {
  await deps.db.transaction(async (tx) => {
    const v = await loadVendor(tx, id, true);
    if (!canView(user, v)) throw notFound('Vendor');
    checkVersion(v, body.version);
    if (action === 'submit' && !canEdit(user, v)) throw forbidden('Only the requester can submit this vendor');

    const blockers = action === 'submit' ? blockersFor(v, await loadDocs(tx, id)) : [];
    const decision = decide(
      { state: v.state, approvals: v.approvals },
      action,
      { kind: 'user', id: user.id, roles: user.roles },
      { submissionBlockers: blockers, ...(body.reason ? { reason: body.reason } : {}) },
    );
    if (!decision.ok) {
      if (decision.code === 'FORBIDDEN') throw forbidden(decision.message);
      throw unprocessable(decision.code, decision.message);
    }
    await applyTransition(tx, v, decision.to, decision.effects, user, decision.actingRole, action, body.reason ?? null, deps.cfg);
  });
  return getVendor(deps, user, id);
}

/** Applies a decided transition and its effects atomically. Shared with the SAP worker. */
export async function applyTransition(
  tx: Queryable,
  v: VendorRow,
  to: State,
  effects: { type: string; role?: string }[],
  actor: UserDTO | null,
  role: string,
  action: string,
  reason: string | null,
  cfg: Config,
) {
  let approvals = v.approvals;
  for (const e of effects) {
    if (e.type === 'clear_approvals') approvals = [];
    if (e.type === 'record_approval' && actor)
      approvals = [...approvals, { role: e.role as Approval['role'], by: actor.name, at: new Date().toISOString() }];
    if (e.type === 'enqueue_sap_sync') {
      // Allocate the card code exactly once; retries reuse it.
      await tx.query(
        `INSERT INTO sap_sync (vendor_id, status, card_code, idempotency_key)
         VALUES ($1, 'QUEUED', $2 || lpad(nextval('sap_card_code_seq')::text, 6, '0'), gen_random_uuid()::text)
         ON CONFLICT (vendor_id) DO UPDATE SET status = 'QUEUED', last_error = NULL, updated_at = now()`,
        [v.id, cfg.SAP_CARD_CODE_PREFIX],
      );
      await enqueue(tx, 'sap_sync', { vendorId: v.id }, { dedupeKey: `sap:${v.id}`, maxAttempts: cfg.SAP_MAX_ATTEMPTS });
    }
  }
  await tx.query(
    `UPDATE vendors SET state = $2, approvals = $3, version = version + 1, updated_at = now(),
       submitted_at = CASE WHEN $2 = 'IN_REVIEW' AND $4 = 'submit' THEN now() ELSE submitted_at END,
       onboarded_at = CASE WHEN $2 = 'ONBOARDED' THEN now() ELSE onboarded_at END
     WHERE id = $1`,
    [v.id, to, JSON.stringify(approvals), action],
  );
  await logEvent(tx, { vendorId: v.id, action, from: v.state, to, actor, role, reason });
}

export { loadVendor, loadDocs, logEvent, type VendorRow, type DocRow };
