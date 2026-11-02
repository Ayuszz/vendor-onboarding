import type { State } from '@vo/shared';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { STAGES } from '../components/Journey';
import { VendorList } from '../components/VendorList';
import { Button, Empty, Panel, PanelHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Overview() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats });
  const queue = useQuery({ queryKey: ['vendors', { queue: true, limit: 6 }], queryFn: () => api.list({ queue: true, limit: 6 }) });
  const isRequester = !!user?.roles.includes('REQUESTER');
  const n = stats.data?.myQueue ?? 0;
  const by = stats.data?.byState ?? {};
  const count = (states: readonly State[]) => states.reduce((s, k) => s + (by[k] ?? 0), 0);

  return (
    <div className="space-y-5">
      {/* Hero: the sentence that matters to this person, set large. */}
      <Panel className="overflow-hidden px-6 py-8 sm:px-10 sm:py-12">
        <p className="text-[15px] text-ink-2">
          {greeting()}, {user?.name.split(' ')[0]}
        </p>
        {stats.isPending ? (
          <Skeleton className="mt-3 h-14 w-3/4" />
        ) : (
          <h1 className="mt-2 max-w-[18ch] text-[40px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[56px]">
            {n === 0
              ? 'Nothing is waiting on you.'
              : `${n} ${n === 1 ? 'vendor is' : 'vendors are'} waiting on you.`}
          </h1>
        )}
        <div className="mt-7 flex flex-wrap gap-2">
          {n > 0 && (
            <Button variant="primary" size="lg" icon={<Inbox className="size-[18px]" />} onClick={() => navigate('/queue')}>
              Open my queue
            </Button>
          )}
          {isRequester && (
            <Button variant={n > 0 ? 'secondary' : 'primary'} size="lg" icon={<Plus className="size-[18px]" />} onClick={() => navigate('/vendors/new')}>
              Start a new vendor
            </Button>
          )}
        </div>
      </Panel>

      {/* Pipeline: where every vendor currently sits, in workflow order. */}
      <Panel>
        <PanelHeader
          title="Pipeline"
          description={
            stats.data?.avgDaysToOnboard != null
              ? stats.data.avgDaysToOnboard < 1
                ? 'Vendors reach SAP in under a day on average after submission.'
                : `Vendors take ${stats.data.avgDaysToOnboard} days on average from submission to SAP.`
              : 'Where every vendor currently sits.'
          }
        />
        <ol className="grid grid-cols-2 gap-px px-3 pb-3 sm:grid-cols-5">
          {STAGES.map((s, i) => {
            const c = count(s.states);
            const attention = s.key === 'sap' ? (by.SAP_ERROR ?? 0) : s.key === 'draft' ? (by.SENT_BACK ?? 0) : 0;
            return (
              <li key={s.key} className="rounded-(--radius-control) p-3">
                <Link
                  to={`/vendors?state=${s.states[0]}`}
                  className="focus-ring block rounded-(--radius-control) transition-opacity hover:opacity-75"
                >
                  <span className="text-[12px] text-ink-3">Step {i + 1}</span>
                  <span className="tabular mt-1 block text-[34px] leading-none font-semibold tracking-[-0.02em]">
                    {stats.isPending ? '–' : c}
                  </span>
                  <span className="mt-1.5 block text-[13px] text-ink-2">{s.label}</span>
                  {attention > 0 && (
                    <span className="mt-1 block text-[12px] font-medium text-warn">
                      {attention} {s.key === 'sap' ? 'failed' : 'sent back'}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ol>
      </Panel>

      <Panel>
        <PanelHeader
          title={isRequester ? 'Needs your input' : 'Your queue'}
          action={
            <Link to="/queue" className="focus-ring rounded text-[14px] font-medium text-accent">
              See all
            </Link>
          }
        />
        {queue.data?.items.length === 0 ? (
          <Empty
            icon={<Inbox className="size-6" />}
            title="You’re all caught up"
            body={isRequester ? 'Drafts and vendors sent back to you appear here.' : 'Vendors appear here when they reach your review step.'}
          />
        ) : (
          <VendorList items={queue.data?.items} loading={queue.isPending} />
        )}
      </Panel>
    </div>
  );
}
