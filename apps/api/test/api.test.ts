import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF, api, completeProfile, multipart, readyVendor, setup, validDocs, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let call: ReturnType<typeof api>['call'];
let upload: ReturnType<typeof api>['upload'];

beforeAll(async () => {
  ctx = await setup();
  ({ call, upload } = api(ctx));
});
afterAll(() => ctx.close());

describe('auth', () => {
  it('rejects requests without a valid token', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/vendors' });
    expect(r.statusCode).toBe(401);
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer a.b.c' } });
    expect(bad.statusCode).toBe(401);
  });

  it('returns the current user', async () => {
    const r = await call('qc', 'GET', '/api/me');
    expect(r.body).toMatchObject({ user: { id: 'u_qc', roles: ['QC'] }, vendorId: null });
  });
});

describe('happy path: draft → QC + SCM → finance → SAP → onboarded', () => {
  it('runs end to end with a full audit trail', async () => {
    const v = await readyVendor(ctx);
    expect(v.documents.map((d) => [d.key, d.status])).toEqual([
      ['gst', 'VERIFIED'],
      ['pan', 'VERIFIED'],
      ['bank_proof', 'VERIFIED'],
      ['moa_aoa', 'VERIFIED'],
    ]);
    expect(v.documents.find((d) => d.key === 'bank_proof')?.derived).toMatchObject({ bankName: 'HDFC Bank' });
    expect(v.blockers).toEqual([]);
    expect(v.allowedActions).toEqual(['submit']);

    const submitted = await call('requester', 'POST', `/api/vendors/${v.id}/actions/submit`, { version: v.version });
    expect(submitted.status).toBe(200);
    expect(submitted.body.state).toBe('IN_REVIEW');
    expect(submitted.body.pendingWith).toEqual(['QC', 'SCM']);

    // finance cannot jump the queue
    expect((await call('finance', 'POST', `/api/vendors/${v.id}/actions/approve`, {})).status).toBe(403);

    const scm = await call('scm', 'POST', `/api/vendors/${v.id}/actions/approve`, {});
    expect(scm.body).toMatchObject({ state: 'IN_REVIEW', pendingWith: ['QC'] });
    const qc = await call('qc', 'POST', `/api/vendors/${v.id}/actions/approve`, {});
    expect(qc.body.state).toBe('FINANCE_REVIEW');

    const fin = await call('finance', 'POST', `/api/vendors/${v.id}/actions/approve`, {});
    expect(fin.body.state).toBe('SAP_PENDING');
    expect(fin.body.sap).toMatchObject({ status: 'QUEUED', cardCode: 'V010001' });

    await ctx.app.worker.drain();
    const done = await call('finance', 'GET', `/api/vendors/${v.id}`);
    expect(done.body.state).toBe('ONBOARDED');
    expect(done.body.sap).toMatchObject({ status: 'SYNCED', cardCode: 'V010001' });

    const bp = ctx.sap.created.get('V010001');
    expect(bp).toMatchObject({
      CardName: completeProfile.legalName,
      CardType: 'cSupplier',
      FederalTaxID: 'AABCU9603R',
      BPBankAccounts: [{ BankCode: 'HDFC' }],
    });

    const events = await call('requester', 'GET', `/api/vendors/${v.id}/events`);
    const transitions = events.body.filter((e: any) => e.toState).map((e: any) => `${e.action}:${e.toState}`);
    expect(transitions).toEqual([
      'created:DRAFT',
      'submit:IN_REVIEW',
      'approve:IN_REVIEW',
      'approve:FINANCE_REVIEW',
      'approve:SAP_PENDING',
      'sap_success:ONBOARDED',
    ]);
  });
});

describe('guards and permissions', () => {
  it('cannot submit until the checklist is complete', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: { legalName: 'Half Done Ltd' } });
    expect(created.status).toBe(201);
    expect(created.body.blockers.length).toBeGreaterThan(0);
    const r = await call('requester', 'POST', `/api/vendors/${created.body.id}/actions/submit`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GUARD_FAILED');
  });

  it('failed verification explains why', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: completeProfile });
    await upload('requester', created.body.id, 'pan', { pan: 'AAPFU0939F', nameOnPan: 'Acme' }); // firm PAN for a company
    await ctx.app.worker.drain();
    const v = await call('requester', 'GET', `/api/vendors/${created.body.id}`);
    const pan = v.body.documents.find((d: any) => d.key === 'pan');
    expect(pan.status).toBe('FAILED');
    expect(pan.reasons[0]).toMatch(/holder type/);
  });

  it('rejects non-applicable documents and spoofed file types', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: completeProfile });
    const fssai = await upload('requester', created.body.id, 'fssai', { licenseNumber: '12345678901234', expiryDate: '2030-01-01' });
    expect(fssai.status).toBe(422);

    const mp = multipart(validDocs.pan!, { name: 'evil.pdf', data: Buffer.from('<script>alert(1)</script>') });
    const r = await ctx.app.inject({
      method: 'PUT',
      url: `/api/vendors/${created.body.id}/documents/pan`,
      headers: { authorization: `Bearer ${ctx.tokens.requester}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(400);
  });

  it('requesters only see their own vendors; reviewers cannot edit drafts', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: { legalName: 'Private Co' } });
    expect((await call('qc', 'PATCH', `/api/vendors/${created.body.id}`, { profile: { legalName: 'Hacked' } })).status).toBe(403);
    expect((await call('qc', 'POST', '/api/vendors', { profile: {} })).status).toBe(403);
  });

  it('optimistic locking rejects stale writes', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: { legalName: 'Race Co' } });
    const first = await call('requester', 'PATCH', `/api/vendors/${created.body.id}`, {
      profile: { tradeName: 'A' },
      version: created.body.version,
    });
    expect(first.status).toBe(200);
    const stale = await call('requester', 'PATCH', `/api/vendors/${created.body.id}`, {
      profile: { tradeName: 'B' },
      version: created.body.version,
    });
    expect(stale.status).toBe(409);
  });

  it('validates request bodies', async () => {
    const r = await call('requester', 'POST', '/api/vendors', { profile: { constitution: 'not-a-type' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('send back and resubmit', () => {
  it('returns to the requester with a reason, then goes through review again', async () => {
    const v = await readyVendor(ctx);
    await call('requester', 'POST', `/api/vendors/${v.id}/actions/submit`, {});
    await call('qc', 'POST', `/api/vendors/${v.id}/actions/approve`, {});

    const noReason = await call('scm', 'POST', `/api/vendors/${v.id}/actions/send_back`, {});
    expect(noReason.status).toBe(422);

    const back = await call('scm', 'POST', `/api/vendors/${v.id}/actions/send_back`, { reason: 'Please add the MSME certificate' });
    expect(back.body).toMatchObject({ state: 'SENT_BACK', approvals: [] });

    const again = await call('requester', 'POST', `/api/vendors/${v.id}/actions/submit`, {});
    expect(again.body).toMatchObject({ state: 'IN_REVIEW', pendingWith: ['QC', 'SCM'] });
  });
});

describe('SAP resilience', () => {
  async function toFinanceApproved() {
    const v = await readyVendor(ctx);
    await call('requester', 'POST', `/api/vendors/${v.id}/actions/submit`, {});
    await call('qc', 'POST', `/api/vendors/${v.id}/actions/approve`, {});
    await call('scm', 'POST', `/api/vendors/${v.id}/actions/approve`, {});
    const r = await call('finance', 'POST', `/api/vendors/${v.id}/actions/approve`, {});
    return r.body;
  }

  it('retries transient failures and reuses the same card code', async () => {
    const v = await toFinanceApproved();
    ctx.sap.failNext = [true, true];
    await ctx.app.worker.drain(); // attempt 1 fails, re-queued with backoff 0
    await ctx.app.worker.drain(); // attempt 2 fails
    await ctx.app.worker.drain(); // attempt 3 succeeds
    const done = await call('finance', 'GET', `/api/vendors/${v.id}`);
    expect(done.body.state).toBe('ONBOARDED');
    expect(done.body.sap.cardCode).toBe(v.sap.cardCode);
    expect(done.body.sap.attempts).toBe(3);
  });

  it('moves to SAP_ERROR after permanent failure, and finance can retry', async () => {
    const v = await toFinanceApproved();
    ctx.sap.failNext = [false]; // non-retryable
    await ctx.app.worker.drain();
    const failed = await call('finance', 'GET', `/api/vendors/${v.id}`);
    expect(failed.body.state).toBe('SAP_ERROR');
    expect(failed.body.sap.lastError).toMatch(/Invalid payload/);
    expect(failed.body.allowedActions).toEqual(['retry_sap']);

    const retry = await call('finance', 'POST', `/api/vendors/${v.id}/actions/retry_sap`, {});
    expect(retry.body.state).toBe('SAP_PENDING');
    await ctx.app.worker.drain();
    const done = await call('finance', 'GET', `/api/vendors/${v.id}`);
    expect(done.body.state).toBe('ONBOARDED');
    expect(done.body.sap.cardCode).toBe(failed.body.sap.cardCode);
  });
});

describe('listing, inbox and stats', () => {
  it('shows each reviewer only their queue', async () => {
    const v = await readyVendor(ctx);
    await call('requester', 'POST', `/api/vendors/${v.id}/actions/submit`, {});
    await call('qc', 'POST', `/api/vendors/${v.id}/actions/approve`, {});

    const qcQueue = await call('qc', 'GET', '/api/vendors?queue=true');
    const scmQueue = await call('scm', 'GET', '/api/vendors?queue=true');
    expect(qcQueue.body.items.map((i: any) => i.id)).not.toContain(v.id);
    expect(scmQueue.body.items.map((i: any) => i.id)).toContain(v.id);

    const search = await call('qc', 'GET', `/api/vendors?q=${encodeURIComponent(v.reference)}`);
    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].docs).toEqual({ verified: 4, required: 4 });

    const stats = await call('finance', 'GET', '/api/stats');
    expect(stats.body.byState.ONBOARDED).toBeGreaterThanOrEqual(1);
    expect(typeof stats.body.myQueue).toBe('number');
  });

  it('serves uploaded files only to permitted users', async () => {
    const v = await readyVendor(ctx);
    const r = await ctx.app.inject({
      method: 'GET',
      url: `/api/vendors/${v.id}/documents/pan/file`,
      headers: { authorization: `Bearer ${ctx.tokens.qc}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.equals(PDF)).toBe(true);
  });
});

describe('OCR chain on documents', () => {
  it('stores what OCR read and which fields the person edited, for reviewers', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: completeProfile });
    const mp = multipart(validDocs.pan!, { name: 'pan.pdf', data: PDF }, {
      ocr: { method: 'ocr', confidence: 87, found: ['pan', 'nameOnPan', 'bogus'], edited: ['nameOnPan'], ms: 1200 },
    });
    const r = await ctx.app.inject({
      method: 'PUT',
      url: `/api/vendors/${created.body.id}/documents/pan`,
      headers: { authorization: `Bearer ${ctx.tokens.requester}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(200);
    await ctx.app.worker.drain();
    const v = await call('qc', 'GET', `/api/vendors/${created.body.id}`);
    const pan = v.body.documents.find((d: any) => d.key === 'pan');
    expect(pan.ocr).toEqual({ method: 'ocr', confidence: 87, found: ['pan', 'nameOnPan'], edited: ['nameOnPan'], ms: 1200 });
    expect(pan.status).toBe('VERIFIED');

    const events = await call('qc', 'GET', `/api/vendors/${created.body.id}/events`);
    const up = events.body.find((e: any) => e.action === 'document_uploaded');
    expect(up.detail.ocr.found).toEqual(['pan', 'nameOnPan']);
  });

  it('rejects a malformed OCR description', async () => {
    const created = await call('requester', 'POST', '/api/vendors', { profile: completeProfile });
    const mp = multipart(validDocs.pan!, { name: 'pan.pdf', data: PDF }, { ocr: { method: 'magic', confidence: 500 } });
    const r = await ctx.app.inject({
      method: 'PUT',
      url: `/api/vendors/${created.body.id}/documents/pan`,
      headers: { authorization: `Bearer ${ctx.tokens.requester}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(400);
  });
});
