/**
 * Vendor onboarding workflow — a pure, declarative state machine.
 *
 *   DRAFT ──submit──▶ IN_REVIEW ──(QC ✓ and SCM ✓)──▶ FINANCE_REVIEW ──approve──▶ SAP_PENDING
 *     ▲                  │  │                            │  │                         │   │
 *     └──── SENT_BACK ◀──┘  └──reject──▶ REJECTED ◀──────┘  └──send_back──▶ SENT_BACK  │   │
 *                                                                        sap_success ┘   └ sap_failure
 *                                                                          ONBOARDED       SAP_ERROR ──retry_sap──▶ SAP_PENDING
 *
 * QC and SCM review in parallel (either order); finance unlocks only when both approve.
 * The engine has no I/O: it returns the next state plus a list of effects for the
 * caller to persist atomically. That makes every transition unit-testable and lets
 * the UI compute exactly which buttons a user may press.
 */

export const STATES = [
  'DRAFT',
  'IN_REVIEW',
  'FINANCE_REVIEW',
  'SAP_PENDING',
  'SAP_ERROR',
  'SENT_BACK',
  'ONBOARDED',
  'REJECTED',
] as const;
export type State = (typeof STATES)[number];

export const STATE_META: Record<State, { label: string; tone: Tone; terminal?: boolean }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SENT_BACK: { label: 'Sent back', tone: 'warning' },
  IN_REVIEW: { label: 'QC & SCM review', tone: 'info' },
  FINANCE_REVIEW: { label: 'Finance review', tone: 'info' },
  SAP_PENDING: { label: 'Syncing to SAP', tone: 'info' },
  SAP_ERROR: { label: 'SAP error', tone: 'danger' },
  ONBOARDED: { label: 'Onboarded', tone: 'success', terminal: true },
  REJECTED: { label: 'Rejected', tone: 'danger', terminal: true },
};
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const ROLES = ['VENDOR', 'REQUESTER', 'QC', 'SCM', 'FINANCE', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  VENDOR: 'Vendor',
  REQUESTER: 'Buyer',
  QC: 'Quality (QC)',
  SCM: 'Supply Chain (SCM)',
  FINANCE: 'Finance',
  ADMIN: 'Admin',
};

/** Reviews that must all approve in IN_REVIEW before finance can act. */
export const PARALLEL_REVIEWERS = ['QC', 'SCM'] as const satisfies readonly Role[];
export type ReviewerRole = (typeof PARALLEL_REVIEWERS)[number] | 'FINANCE';

export const USER_ACTIONS = ['submit', 'approve', 'send_back', 'reject', 'retry_sap'] as const;
export type UserAction = (typeof USER_ACTIONS)[number];
export type SystemAction = 'sap_success' | 'sap_failure';
export type Action = UserAction | SystemAction;

export interface Approval {
  role: ReviewerRole;
  by: string;
  at: string;
}

export interface WorkflowSnapshot {
  state: State;
  approvals: Approval[];
}

export type Actor = { kind: 'user'; id: string; roles: Role[] } | { kind: 'system' };

export type Effect =
  | { type: 'record_approval'; role: ReviewerRole }
  | { type: 'clear_approvals' }
  | { type: 'enqueue_sap_sync' };

export type Decision =
  | { ok: true; to: State; effects: Effect[]; actingRole: Role | 'SYSTEM' }
  | { ok: false; code: 'FORBIDDEN' | 'INVALID_TRANSITION' | 'GUARD_FAILED'; message: string };

export interface GuardContext {
  /** Reasons the vendor cannot be submitted yet (missing profile fields, unverified docs). */
  submissionBlockers: string[];
  reason?: string;
}

const deny = (code: Extract<Decision, { ok: false }>['code'], message: string): Decision => ({
  ok: false,
  code,
  message,
});

/** Which reviewer role (if any) this actor would act as in the given state. */
export function reviewerRoleFor(snapshot: WorkflowSnapshot, roles: Role[]): ReviewerRole | null {
  if (snapshot.state === 'FINANCE_REVIEW') return roles.includes('FINANCE') ? 'FINANCE' : null;
  if (snapshot.state === 'IN_REVIEW') {
    const done = new Set(snapshot.approvals.map((a) => a.role));
    return PARALLEL_REVIEWERS.find((r) => roles.includes(r) && !done.has(r)) ?? null;
  }
  return null;
}

export function decide(
  snapshot: WorkflowSnapshot,
  action: Action,
  actor: Actor,
  ctx: GuardContext = { submissionBlockers: [] },
): Decision {
  const { state } = snapshot;

  if (action === 'sap_success' || action === 'sap_failure') {
    if (actor.kind !== 'system') return deny('FORBIDDEN', 'System-only action');
    if (state !== 'SAP_PENDING') return deny('INVALID_TRANSITION', `Cannot ${action} from ${state}`);
    return { ok: true, to: action === 'sap_success' ? 'ONBOARDED' : 'SAP_ERROR', effects: [], actingRole: 'SYSTEM' };
  }

  if (actor.kind !== 'user') return deny('FORBIDDEN', 'User action required');
  const has = (...r: Role[]) => r.some((x) => actor.roles.includes(x));

  switch (action) {
    case 'submit': {
      if (state !== 'DRAFT' && state !== 'SENT_BACK')
        return deny('INVALID_TRANSITION', `Cannot submit from ${state}`);
      if (!has('VENDOR', 'REQUESTER', 'ADMIN')) return deny('FORBIDDEN', 'Only the vendor or requester can submit');
      if (ctx.submissionBlockers.length)
        return deny('GUARD_FAILED', `Not ready to submit: ${ctx.submissionBlockers.join('; ')}`);
      return {
        ok: true,
        to: 'IN_REVIEW',
        effects: [{ type: 'clear_approvals' }],
        actingRole: has('VENDOR') ? 'VENDOR' : has('REQUESTER') ? 'REQUESTER' : 'ADMIN',
      };
    }

    case 'approve': {
      if (state !== 'IN_REVIEW' && state !== 'FINANCE_REVIEW')
        return deny('INVALID_TRANSITION', `Nothing to approve in ${state}`);
      const role = reviewerRoleFor(snapshot, actor.roles);
      if (!role) return deny('FORBIDDEN', 'You have no pending review on this vendor');
      if (role === 'FINANCE')
        return {
          ok: true,
          to: 'SAP_PENDING',
          effects: [{ type: 'record_approval', role }, { type: 'enqueue_sap_sync' }],
          actingRole: role,
        };
      const approved = new Set([...snapshot.approvals.map((a) => a.role), role]);
      const allDone = PARALLEL_REVIEWERS.every((r) => approved.has(r));
      return {
        ok: true,
        to: allDone ? 'FINANCE_REVIEW' : 'IN_REVIEW',
        effects: [{ type: 'record_approval', role }],
        actingRole: role,
      };
    }

    case 'send_back':
    case 'reject': {
      if (state !== 'IN_REVIEW' && state !== 'FINANCE_REVIEW')
        return deny('INVALID_TRANSITION', `Cannot ${action} from ${state}`);
      const role =
        state === 'FINANCE_REVIEW'
          ? has('FINANCE') ? 'FINANCE' : null
          : (PARALLEL_REVIEWERS.find((r) => actor.roles.includes(r)) ?? null);
      if (!role) return deny('FORBIDDEN', 'Only an assigned reviewer can do this');
      if (!ctx.reason || ctx.reason.trim().length < 5)
        return deny('GUARD_FAILED', 'A reason of at least 5 characters is required');
      return {
        ok: true,
        to: action === 'reject' ? 'REJECTED' : 'SENT_BACK',
        effects: [{ type: 'clear_approvals' }],
        actingRole: role,
      };
    }

    case 'retry_sap': {
      if (state !== 'SAP_ERROR') return deny('INVALID_TRANSITION', `Cannot retry from ${state}`);
      if (!has('FINANCE', 'ADMIN')) return deny('FORBIDDEN', 'Only Finance or Admin can retry');
      return {
        ok: true,
        to: 'SAP_PENDING',
        effects: [{ type: 'enqueue_sap_sync' }],
        actingRole: has('FINANCE') ? 'FINANCE' : 'ADMIN',
      };
    }
  }
}

/** Actions this actor could attempt right now (guards like blockers/reason are checked on submit). */
export function availableActions(snapshot: WorkflowSnapshot, roles: Role[]): UserAction[] {
  const actor: Actor = { kind: 'user', id: '_', roles };
  return USER_ACTIONS.filter((a) => {
    const d = decide(snapshot, a, actor, { submissionBlockers: [], reason: 'probe reason' });
    return d.ok;
  });
}

/** Roles whose queue a vendor in this snapshot currently sits in. */
export function pendingWith(snapshot: WorkflowSnapshot): Role[] {
  switch (snapshot.state) {
    case 'DRAFT':
    case 'SENT_BACK':
      return ['VENDOR'];
    case 'IN_REVIEW': {
      const done = new Set(snapshot.approvals.map((a) => a.role));
      return PARALLEL_REVIEWERS.filter((r) => !done.has(r));
    }
    case 'FINANCE_REVIEW':
    case 'SAP_ERROR':
      return ['FINANCE'];
    default:
      return [];
  }
}

export const ACTION_LABELS: Record<Action, string> = {
  submit: 'Submitted for approval',
  approve: 'Approved',
  send_back: 'Sent back',
  reject: 'Rejected',
  retry_sap: 'Retried SAP sync',
  sap_success: 'Created in SAP',
  sap_failure: 'SAP sync failed',
};
