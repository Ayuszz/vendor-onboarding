import type { Approval, State } from '@vo/shared';
import clsx from 'clsx';
import { AlertTriangle, Check, X } from 'lucide-react';

export const STAGES = [
  { key: 'draft', label: 'Details & documents', states: ['DRAFT', 'SENT_BACK'] },
  { key: 'review', label: 'QC & SCM review', states: ['IN_REVIEW'] },
  { key: 'finance', label: 'Finance approval', states: ['FINANCE_REVIEW'] },
  { key: 'sap', label: 'SAP creation', states: ['SAP_PENDING', 'SAP_ERROR'] },
  { key: 'done', label: 'Onboarded', states: ['ONBOARDED'] },
] as const satisfies readonly { key: string; label: string; states: readonly State[] }[];

export const stageIndex = (s: State) => STAGES.findIndex((st) => (st.states as readonly State[]).includes(s));

/**
 * The vendor's journey as one continuous glass track. The segment the vendor is in
 * carries a travelling highlight — the only ambient animation in the app.
 */
export function Journey({ state, approvals }: { state: State; approvals: Approval[] }) {
  const rejected = state === 'REJECTED';
  const current = rejected ? -1 : stageIndex(state);
  const problem = state === 'SENT_BACK' || state === 'SAP_ERROR';
  const done = state === 'ONBOARDED';
  const approved = new Set(approvals.map((a) => a.role));

  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Onboarding progress">
      {STAGES.map((stage, i) => {
        const complete = done || i < current;
        const active = !done && i === current;
        const sub =
          stage.key === 'review' && (active || complete)
            ? (['QC', 'SCM'] as const).map((r) => `${r} ${approved.has(r) || complete ? '✓' : '…'}`).join('  ')
            : null;
        return (
          <li key={stage.key} className="min-w-0" aria-current={active ? 'step' : undefined}>
            <div
              className={clsx(
                'relative h-1.5 overflow-hidden rounded-full',
                complete && 'bg-ok',
                active && !problem && 'journey-live bg-accent',
                active && problem && 'bg-warn',
                !complete && !active && (rejected ? 'bg-bad/30' : 'bg-[var(--field-bg-hover)]'),
              )}
            />
            <div className="mt-2.5 flex items-start gap-1.5">
              <span
                className={clsx(
                  'mt-px grid size-4 shrink-0 place-items-center rounded-full',
                  complete && 'bg-ok text-white',
                  active && !problem && 'bg-accent text-white',
                  active && problem && 'bg-warn text-white',
                  !complete && !active && 'bg-[var(--field-bg-hover)]',
                )}
                aria-hidden
              >
                {complete ? (
                  <Check className="size-2.5" strokeWidth={3.5} />
                ) : active && problem ? (
                  <AlertTriangle className="size-2.5" strokeWidth={3} />
                ) : rejected && i === 0 ? (
                  <X className="size-2.5" />
                ) : null}
              </span>
              <span className="min-w-0">
                <span
                  className={clsx(
                    'block truncate text-[12px] sm:text-[13px]',
                    active ? 'font-semibold text-ink' : complete ? 'text-ink-2' : 'text-ink-3',
                  )}
                >
                  {stage.label}
                </span>
                {sub && <span className="tabular hidden text-[11px] text-ink-3 sm:block">{sub}</span>}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
