import {
  ACTION_LABELS,
  CATEGORY_LABELS,
  CONSTITUTION_LABELS,
  DOCUMENTS,
  ROLE_LABELS,
  STATE_META,
  applicableDocuments,
  reviewerRoleFor,
  type Action,
  type EventDTO,
  type UserAction,
} from '@vo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, Pencil, RotateCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DocumentCard } from '../components/DocumentCard';
import { Journey } from '../components/Journey';
import { Avatar, Button, Dialog, Empty, Panel, PanelHeader, Skeleton, StatePill, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';

const EVENT_LABELS: Record<EventDTO['action'], string> = {
  ...ACTION_LABELS,
  created: 'Created the draft',
  document_uploaded: 'Uploaded a document',
  document_verified: 'Document verified',
  document_failed: 'Document failed checks',
};

/** Plain-language status for vendors looking at their own application. */
const VENDOR_STATUS: Record<string, string> = {
  DRAFT: 'Your application is not submitted yet. Finish your details and documents, then submit it for review.',
  SENT_BACK: 'Our team asked for a few changes. Update the details below and submit again.',
  IN_REVIEW: 'Thanks, we have your application. Our quality and supply-chain teams are reviewing it now.',
  FINANCE_REVIEW: 'Quality and supply-chain checks are done. Finance is giving the final approval.',
  SAP_PENDING: 'Approved. We are setting you up in our purchasing system.',
  SAP_ERROR: 'Approved. Setting you up in our purchasing system is taking a little longer than usual; our team is on it.',
  ONBOARDED: 'You are a registered vendor. Your vendor code is shown above.',
  REJECTED: 'We are unable to onboard your company at this time.',
};

const SUCCESS_TOAST: Record<UserAction, string> = {
  submit: 'Submitted for approval',
  approve: 'Approved',
  send_back: 'Sent back to the requester',
  reject: 'Vendor rejected',
  retry_sap: 'SAP sync restarted',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3 py-2 text-[14px]">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words">{children || '—'}</dd>
    </div>
  );
}

export default function VendorDetail() {
  const { id } = useParams() as { id: string };
  const { user, isVendor } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<'send_back' | 'reject' | null>(null);
  const [reason, setReason] = useState('');

  const vendor = useQuery({
    queryKey: ['vendor', id],
    queryFn: () => api.get(id),
    refetchInterval: (q) =>
      q.state.data?.state === 'SAP_PENDING' || q.state.data?.documents.some((d) => d.status === 'PENDING') ? 2000 : false,
  });
  const events = useQuery({ queryKey: ['events', id, vendor.data?.version], queryFn: () => api.events(id), enabled: !!vendor.data });

  const act = useMutation({
    mutationFn: (a: { action: UserAction; reason?: string }) =>
      api.act(id, a.action, { version: vendor.data?.version, ...(a.reason ? { reason: a.reason } : {}) }),
    onSuccess: (v, a) => {
      qc.setQueryData(['vendor', id], v);
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      toast(SUCCESS_TOAST[a.action]);
      setDialog(null);
      setReason('');
    },
    onError: (e) => {
      toast(e.message, 'danger');
      if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['vendor', id] });
    },
  });

  if (vendor.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-80" />
      </div>
    );
  if (vendor.isError || !vendor.data)
    return (
      <Panel>
        <Empty icon={<AlertTriangle className="size-6" />} title="Vendor not found" body="It may have been removed, or you don’t have access." action={<Button onClick={() => navigate('/vendors')}>All vendors</Button>} />
      </Panel>
    );

  const v = vendor.data;
  const p = v.profile;
  const can = (a: UserAction) => v.allowedActions.includes(a);
  const editable = v.state === 'DRAFT' || v.state === 'SENT_BACK';
  const actingAs = user ? reviewerRoleFor({ state: v.state, approvals: v.approvals }, user.roles) : null;
  const docs = applicableDocuments(p).filter(
    ({ doc, requirement }) => requirement === 'required' || v.documents.some((d) => d.key === doc.key),
  );
  const hasDock = can('approve') || can('send_back') || can('reject') || can('retry_sap') || (editable && can('submit'));

  return (
    <div className={clsx('space-y-5', hasDock && 'pb-24')}>
      <Panel className="p-5 sm:p-7">
        <div className="flex items-start gap-3">
          {!isVendor && (
            <Button variant="ghost" size="sm" className="-ml-2 !px-2" aria-label="Back" onClick={() => navigate(-1)}>
              <ChevronLeft className="size-5" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em] sm:text-[32px]">{p.legalName || 'Untitled vendor'}</h1>
              <StatePill state={v.state} />
            </div>
            <p className="tabular mt-1 text-[13px] text-ink-3">
              {v.reference}
              {v.sap?.cardCode && v.sap.status === 'SYNCED' ? ` · SAP ${v.sap.cardCode}` : ''} · updated {timeAgo(v.updatedAt)}
            </p>
          </div>
          {editable && can('submit') && (
            <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" />} onClick={() => navigate(`/vendors/${id}/edit`)}>
              Edit
            </Button>
          )}
        </div>
        {isVendor && <p className="mt-4 max-w-[60ch] text-[15px] text-ink-2">{VENDOR_STATUS[v.state]}</p>}
        <div className="mt-7">
          <Journey state={v.state} approvals={v.approvals} />
        </div>
        {v.state === 'SENT_BACK' && (
          <div className="mt-6 flex gap-3 rounded-(--radius-control) bg-warn-soft p-3.5 text-[14px] text-warn">
            <AlertTriangle className="size-5 shrink-0" />
            <div>
              <p className="font-semibold">Changes requested</p>
              <p className="mt-0.5 text-ink">{events.data?.filter((e) => e.action === 'send_back').at(-1)?.reason ?? '…'}</p>
            </div>
          </div>
        )}

        {v.state === 'SAP_ERROR' && v.sap?.lastError && (
          <div className="mt-6 flex gap-3 rounded-(--radius-control) bg-bad-soft p-3.5 text-[14px] text-bad">
            <AlertTriangle className="size-5 shrink-0" />
            <div>
              <p className="font-semibold">SAP couldn’t create this vendor after {v.sap.attempts} attempts</p>
              <p className="mt-0.5 opacity-90">{v.sap.lastError}</p>
            </div>
          </div>
        )}
        {v.state === 'REJECTED' && (
          <p className="mt-6 rounded-(--radius-control) bg-bad-soft p-3.5 text-[14px] text-bad">
            Rejected: {events.data?.filter((e) => e.action === 'reject').at(-1)?.reason ?? '…'}
          </p>
        )}
      </Panel>

      <div className={clsx('grid gap-5', !isVendor && 'xl:grid-cols-[minmax(0,1fr)_360px]')}>
        <div className="min-w-0 space-y-5">
          <Panel>
            <PanelHeader title="Vendor details" />
            <dl className="hairline grid divide-[var(--glass-line)] px-5 pb-5 sm:px-6 md:grid-cols-2 md:gap-x-8">
              <div>
                <Row label="Trade name">{p.tradeName}</Row>
                <Row label="Constitution">{p.constitution && CONSTITUTION_LABELS[p.constitution]}</Row>
                <Row label="Supplies">{p.category && CATEGORY_LABELS[p.category]}</Row>
                <Row label="Payment terms">{p.paymentTermsDays != null ? `${p.paymentTermsDays} days` : ''}</Row>
                <Row label="Flags">
                  {[p.isMsme && 'MSME', p.isFoodBusiness && 'Food business', p.isImportExport && 'Import / export'].filter(Boolean).join(', ') || 'None'}
                </Row>
              </div>
              <div>
                <Row label="Contact">
                  {p.contact?.name}
                  {p.contact?.email && <span className="block text-ink-2">{p.contact.email}</span>}
                  {p.contact?.phone && <span className="tabular block text-ink-2">{p.contact.phone}</span>}
                </Row>
                <Row label="Address">
                  {[p.address?.line1, p.address?.line2, p.address?.city, p.address?.state, p.address?.pincode].filter(Boolean).join(', ')}
                </Row>
                <Row label="Bank">
                  <span className="tabular">
                    {p.bank?.accountNumber ? `•••• ${p.bank.accountNumber.slice(-4)}` : ''} {p.bank?.ifsc}
                  </span>
                </Row>
              </div>
            </dl>
          </Panel>

          <Panel>
            <PanelHeader
              title="Documents"
              description={`${v.documents.filter((d) => d.status === 'VERIFIED').length} of ${docs.length} verified`}
            />
            <div className="space-y-3 px-3 pb-3 sm:px-4 sm:pb-4">
              {docs.map(({ doc, requirement }) => (
                <DocumentCard key={doc.key} vendor={v} type={doc} requirement={requirement} editable={false} />
              ))}
            </div>
          </Panel>
        </div>

        <Panel as="aside" className={clsx('self-start', !isVendor && 'xl:sticky xl:top-5')}>
          <PanelHeader title="Activity" />
          <ol className="relative px-5 pb-5 sm:px-6">
            {events.isPending && <Skeleton className="h-40" />}
            {events.data
              ?.slice()
              .reverse()
              .map((e, i, arr) => (
                <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
                  {i < arr.length - 1 && <span className="absolute top-8 bottom-0 left-4 w-px bg-[var(--glass-line)]" aria-hidden />}
                  {e.actorName === 'System' ? (
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--field-bg-hover)] text-[11px] text-ink-3">
                      auto
                    </span>
                  ) : (
                    <Avatar name={e.actorName} />
                  )}
                  <div className="min-w-0 pt-0.5 text-[14px]">
                    <p>
                      <span className="font-medium">{e.actorName}</span>{' '}
                      <span className="text-ink-2">{eventText(e)}</span>
                    </p>
                    {e.reason && <p className="mt-1 rounded-(--radius-control) bg-[var(--field-bg)] px-3 py-2 text-[13px]">{e.reason}</p>}
                    <time className="text-[12px] text-ink-3" dateTime={e.at} title={dateTime(e.at)}>
                      {timeAgo(e.at)}
                    </time>
                  </div>
                </li>
              ))}
          </ol>
        </Panel>
      </div>

      {/* Action dock — floating glass bar with exactly the actions this person may take now. */}
      {hasDock && (
        <div className={clsx('fixed inset-x-0 z-30 flex justify-center px-3', isVendor ? 'bottom-6' : 'bottom-20 lg:bottom-6 lg:pl-[268px]')}>
          <div className="glass-strong animate-rise flex max-w-full items-center gap-2 overflow-x-auto rounded-full p-2 pl-5">
            <span className="hidden text-[13px] whitespace-nowrap text-ink-2 sm:inline">
              {actingAs ? `Reviewing as ${ROLE_LABELS[actingAs]}` : v.state === 'SAP_ERROR' ? 'SAP sync failed' : STATE_META[v.state].label}
            </span>
            {can('reject') && (
              <Button variant="ghost" onClick={() => setDialog('reject')}>
                Reject
              </Button>
            )}
            {can('send_back') && (
              <Button variant="secondary" onClick={() => setDialog('send_back')}>
                Send back
              </Button>
            )}
            {can('approve') && (
              <Button variant="success" loading={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>
                Approve{actingAs === 'FINANCE' ? ' and create in SAP' : ''}
              </Button>
            )}
            {can('retry_sap') && (
              <Button variant="primary" icon={<RotateCw className="size-4" />} loading={act.isPending} onClick={() => act.mutate({ action: 'retry_sap' })}>
                Retry SAP sync
              </Button>
            )}
            {editable && can('submit') && (
              <Button variant="primary" onClick={() => navigate(`/vendors/${id}/edit?step=${v.blockers.length ? 3 : 4}`)}>
                {v.state === 'SENT_BACK' ? 'Make changes' : v.blockers.length ? (isVendor ? 'Continue application' : 'Continue editing') : 'Review and submit'}
              </Button>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === 'reject' ? 'Reject this vendor?' : 'Send back to requester'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={dialog === 'reject' ? 'danger' : 'primary'}
              disabled={reason.trim().length < 5}
              loading={act.isPending}
              onClick={() => dialog && act.mutate({ action: dialog, reason })}
            >
              {dialog === 'reject' ? 'Reject vendor' : 'Send back'}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[14px] text-ink-2">
          {dialog === 'reject'
            ? 'Rejection is final. The requester will see your reason.'
            : 'The requester can fix the details and resubmit. Approvals so far will be cleared.'}
        </p>
        <label className="text-[13px] font-medium text-ink-2" htmlFor="reason">
          Reason
        </label>
        <textarea
          id="reason"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={dialog === 'reject' ? 'Why is this vendor being rejected?' : 'What needs to change?'}
          className="field mt-1.5 resize-none"
          autoFocus
        />
      </Dialog>
    </div>
  );
}

function eventText(e: EventDTO) {
  const doc = typeof e.detail?.document === 'string' ? DOCUMENTS[e.detail.document as keyof typeof DOCUMENTS]?.label : null;
  if (e.action === 'document_uploaded') return `uploaded ${doc ?? 'a document'}`;
  if (e.action === 'document_verified') return `verified ${doc ?? 'a document'}`;
  if (e.action === 'document_failed') return `flagged ${doc ?? 'a document'}`;
  if (e.action === 'approve' && e.role) return `approved as ${ROLE_LABELS[e.role as keyof typeof ROLE_LABELS] ?? e.role}`;
  return EVENT_LABELS[e.action as Action | 'created']?.toLowerCase() ?? e.action;
}
