import { describe, expect, it } from 'vitest';
import {
  availableActions,
  decide,
  pendingWith,
  type Actor,
  type Role,
  type WorkflowSnapshot,
} from '../src/index.js';

const user = (...roles: Role[]): Actor => ({ kind: 'user', id: 'u', roles });
const snap = (state: WorkflowSnapshot['state'], approvals: WorkflowSnapshot['approvals'] = []): WorkflowSnapshot => ({
  state,
  approvals,
});
const approval = (role: 'QC' | 'SCM' | 'FINANCE') => ({ role, by: 'x', at: '2026-01-01T00:00:00Z' });

describe('submit', () => {
  it('moves a ready draft into parallel review', () => {
    const d = decide(snap('DRAFT'), 'submit', user('REQUESTER'));
    expect(d).toMatchObject({ ok: true, to: 'IN_REVIEW' });
  });

  it('is blocked while the checklist has open items', () => {
    const d = decide(snap('DRAFT'), 'submit', user('REQUESTER'), { submissionBlockers: ['PAN Card not uploaded'] });
    expect(d).toMatchObject({ ok: false, code: 'GUARD_FAILED' });
  });

  it('vendors can submit their own application', () => {
    expect(decide(snap('DRAFT'), 'submit', user('VENDOR'))).toMatchObject({ ok: true, actingRole: 'VENDOR' });
    expect(pendingWith(snap('SENT_BACK'))).toEqual(['VENDOR']);
  });

  it('can be resubmitted after being sent back, and reviewers cannot submit', () => {
    expect(decide(snap('SENT_BACK'), 'submit', user('REQUESTER')).ok).toBe(true);
    expect(decide(snap('DRAFT'), 'submit', user('QC'))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('parallel QC + SCM review', () => {
  it.each([
    ['QC first', 'QC', 'SCM'],
    ['SCM first', 'SCM', 'QC'],
  ] as const)('%s: finance unlocks only after both approve', (_n, first, second) => {
    const a = decide(snap('IN_REVIEW'), 'approve', user(first));
    expect(a).toMatchObject({ ok: true, to: 'IN_REVIEW' });
    const b = decide(snap('IN_REVIEW', [approval(first)]), 'approve', user(second));
    expect(b).toMatchObject({ ok: true, to: 'FINANCE_REVIEW' });
  });

  it('prevents the same role approving twice', () => {
    const d = decide(snap('IN_REVIEW', [approval('QC')]), 'approve', user('QC'));
    expect(d).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('a user holding both roles approves one at a time', () => {
    const d1 = decide(snap('IN_REVIEW'), 'approve', user('QC', 'SCM'));
    expect(d1).toMatchObject({ ok: true, to: 'IN_REVIEW', actingRole: 'QC' });
  });

  it('finance cannot act during QC/SCM review', () => {
    expect(decide(snap('IN_REVIEW'), 'approve', user('FINANCE')).ok).toBe(false);
  });

  it('tracks who the vendor is pending with', () => {
    expect(pendingWith(snap('IN_REVIEW', [approval('SCM')]))).toEqual(['QC']);
    expect(pendingWith(snap('FINANCE_REVIEW'))).toEqual(['FINANCE']);
  });
});

describe('finance, send back, reject', () => {
  it('finance approval queues the SAP sync', () => {
    const d = decide(snap('FINANCE_REVIEW', [approval('QC'), approval('SCM')]), 'approve', user('FINANCE'));
    expect(d).toMatchObject({ ok: true, to: 'SAP_PENDING' });
    if (d.ok) expect(d.effects).toContainEqual({ type: 'enqueue_sap_sync' });
  });

  it('send back requires a reason and clears approvals', () => {
    expect(decide(snap('IN_REVIEW'), 'send_back', user('QC'))).toMatchObject({ ok: false, code: 'GUARD_FAILED' });
    const d = decide(snap('IN_REVIEW', [approval('SCM')]), 'send_back', user('QC'), {
      submissionBlockers: [],
      reason: 'GST certificate is blurry',
    });
    expect(d).toMatchObject({ ok: true, to: 'SENT_BACK' });
    if (d.ok) expect(d.effects).toContainEqual({ type: 'clear_approvals' });
  });

  it('reject is terminal', () => {
    const d = decide(snap('FINANCE_REVIEW'), 'reject', user('FINANCE'), { submissionBlockers: [], reason: 'Blacklisted vendor' });
    expect(d).toMatchObject({ ok: true, to: 'REJECTED' });
    expect(availableActions(snap('REJECTED'), ['ADMIN', 'FINANCE', 'QC', 'SCM', 'REQUESTER', 'VENDOR'])).toEqual([]);
  });
});

describe('SAP outcomes', () => {
  it('only the system can report SAP results', () => {
    expect(decide(snap('SAP_PENDING'), 'sap_success', user('ADMIN')).ok).toBe(false);
    expect(decide(snap('SAP_PENDING'), 'sap_success', { kind: 'system' })).toMatchObject({ ok: true, to: 'ONBOARDED' });
    expect(decide(snap('SAP_PENDING'), 'sap_failure', { kind: 'system' })).toMatchObject({ ok: true, to: 'SAP_ERROR' });
  });

  it('finance can retry a failed sync', () => {
    expect(decide(snap('SAP_ERROR'), 'retry_sap', user('FINANCE'))).toMatchObject({ ok: true, to: 'SAP_PENDING' });
    expect(decide(snap('SAP_ERROR'), 'retry_sap', user('QC')).ok).toBe(false);
  });
});
