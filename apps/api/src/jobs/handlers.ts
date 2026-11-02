import { DOCUMENTS, decide, normalizeId, vendorProfileSchema, type DocContext, type DocumentKey } from '@vo/shared';
import { SapError, type SapClient } from '../integrations/sap.js';
import { applyTransition, loadDocs, loadVendor, logEvent, type Deps } from '../services/vendors.js';
import { complete, fail, type Job } from './queue.js';

export interface WorkerDeps extends Deps {
  sap: SapClient;
  /** Base backoff in ms (tests use a tiny value). */
  backoffBaseMs?: number;
}

/**
 * Re-runs the declarative checks for one document. Stale jobs (the document was
 * re-uploaded since) are skipped by comparing revisions — last write wins.
 */
async function verifyDocument(deps: WorkerDeps, job: Job<{ vendorId: string; docKey: DocumentKey; revision: number }>) {
  const { vendorId, docKey, revision } = job.payload;
  await deps.db.transaction(async (tx) => {
    const v = await loadVendor(tx, vendorId, true).catch(() => null);
    if (!v) return;
    const docs = await loadDocs(tx, vendorId);
    const doc = docs.find((d) => d.doc_key === docKey);
    if (!doc || doc.revision !== revision) return;

    const ctx: DocContext = Object.fromEntries(docs.map((d) => [d.doc_key, d.fields]));
    const res = DOCUMENTS[docKey].verify(doc.fields, v.profile, ctx);
    // Extension point: call an external verification provider (GSTN, NSDL PAN, penny-drop
    // bank validation) here and merge its result before persisting.
    await tx.query(
      `UPDATE vendor_documents SET status = $3, reasons = $4, derived = $5, verified_at = now()
       WHERE vendor_id = $1 AND doc_key = $2 AND revision = $6`,
      [vendorId, docKey, res.ok ? 'VERIFIED' : 'FAILED', JSON.stringify(res.reasons), JSON.stringify(res.derived ?? {}), revision],
    );
    await logEvent(tx, {
      vendorId,
      action: res.ok ? 'document_verified' : 'document_failed',
      actor: null,
      role: 'SYSTEM',
      detail: { document: docKey, reasons: res.reasons },
    });
  });
}

async function sapSync(deps: WorkerDeps, job: Job<{ vendorId: string }>) {
  const { vendorId } = job.payload;
  const v = await loadVendor(deps.db, vendorId).catch(() => null);
  if (!v || v.state !== 'SAP_PENDING') return; // nothing to do (e.g. already synced)

  const { rows } = await deps.db.query<{ card_code: string; idempotency_key: string }>(
    'SELECT card_code, idempotency_key FROM sap_sync WHERE vendor_id = $1',
    [vendorId],
  );
  const sync = rows[0];
  if (!sync) throw new SapError('Missing SAP sync record', false);

  const profile = vendorProfileSchema.safeParse(v.profile);
  if (!profile.success) throw new SapError('Vendor profile is incomplete', false);
  const docs = await loadDocs(deps.db, vendorId);
  const field = (k: DocumentKey, f: string) => {
    const val = docs.find((d) => d.doc_key === k)?.fields[f];
    return val ? normalizeId(val) : undefined;
  };

  const gstin = field('gst', 'gstin');
  const pan = field('pan', 'pan');
  await deps.sap.createBusinessPartner({
    cardCode: sync.card_code,
    idempotencyKey: sync.idempotency_key,
    profile: profile.data,
    ...(gstin ? { gstin } : {}),
    ...(pan ? { pan } : {}),
  });

  await deps.db.transaction(async (tx) => {
    const locked = await loadVendor(tx, vendorId, true);
    if (locked.state !== 'SAP_PENDING') return;
    const d = decide({ state: locked.state, approvals: locked.approvals }, 'sap_success', { kind: 'system' });
    if (!d.ok) return;
    await tx.query(
      `UPDATE sap_sync SET status = 'SYNCED', attempts = attempts + 1, last_error = NULL, synced_at = now(), updated_at = now()
       WHERE vendor_id = $1`,
      [vendorId],
    );
    await applyTransition(tx, locked, d.to, [], null, 'SYSTEM', 'sap_success', null, deps.cfg);
  });
}

async function markSapFailed(deps: WorkerDeps, vendorId: string, message: string, final: boolean) {
  await deps.db.transaction(async (tx) => {
    await tx.query(
      `UPDATE sap_sync SET attempts = attempts + 1, last_error = $2, status = $3, updated_at = now() WHERE vendor_id = $1`,
      [vendorId, message.slice(0, 1000), final ? 'FAILED' : 'QUEUED'],
    );
    if (!final) return;
    const v = await loadVendor(tx, vendorId, true);
    const d = decide({ state: v.state, approvals: v.approvals }, 'sap_failure', { kind: 'system' });
    if (d.ok) await applyTransition(tx, v, d.to, [], null, 'SYSTEM', 'sap_failure', message.slice(0, 500), deps.cfg);
  });
}

export async function runJob(deps: WorkerDeps, job: Job): Promise<void> {
  try {
    if (job.type === 'verify_document') await verifyDocument(deps, job as Job<never>);
    else if (job.type === 'sap_sync') await sapSync(deps, job as Job<never>);
    else throw new Error(`Unknown job type ${job.type}`);
    await complete(deps.db, job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof SapError ? err.retryable : true;
    const willRetry = await fail(deps.db, job, message, retryable, deps.backoffBaseMs);
    if (job.type === 'sap_sync') {
      await markSapFailed(deps, (job.payload as { vendorId: string }).vendorId, message, !willRetry);
    }
  }
}
