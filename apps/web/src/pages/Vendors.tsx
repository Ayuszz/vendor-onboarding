import { STATE_META, STATES, type State } from '@vo/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VendorList } from '../components/VendorList';
import { Button, Empty, Panel } from '../components/ui';
import { api } from '../lib/api';

const PAGE = 25;
const FILTERS: (State | 'ALL')[] = ['ALL', 'DRAFT', 'SENT_BACK', 'IN_REVIEW', 'FINANCE_REVIEW', 'SAP_ERROR', 'ONBOARDED', 'REJECTED'];

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Vendors({ mode }: { mode: 'queue' | 'all' }) {
  const [params, setParams] = useSearchParams();
  const stateParam = params.get('state');
  const state = stateParam && (STATES as readonly string[]).includes(stateParam) ? (stateParam as State) : undefined;
  const [q, setQ] = useState(params.get('q') ?? '');
  const [page, setPage] = useState(0);
  const dq = useDebounced(q.trim());

  useEffect(() => setPage(0), [dq, state, mode]);

  const query = { queue: mode === 'queue', state: mode === 'all' ? state : undefined, q: dq || undefined, limit: PAGE, offset: page * PAGE };
  const list = useQuery({ queryKey: ['vendors', query], queryFn: () => api.list(query), placeholderData: keepPreviousData });

  const setState = (s: State | 'ALL') => {
    const next = new URLSearchParams(params);
    if (s === 'ALL') next.delete('state');
    else next.set('state', s);
    setParams(next, { replace: true });
  };

  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 px-1 pt-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.025em]">{mode === 'queue' ? 'My queue' : 'All vendors'}</h1>
          <p className="text-[14px] text-ink-2">
            {mode === 'queue' ? 'Vendors waiting on your action, newest activity first.' : 'Every vendor you have access to.'}
          </p>
        </div>
        <label className="glass flex h-11 w-full items-center gap-2 rounded-full px-4 sm:w-80">
          <Search className="size-4 text-ink-3" aria-hidden />
          <span className="sr-only">Search vendors</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or reference"
            className="w-full bg-transparent text-[15px] outline-none placeholder:text-ink-3"
          />
        </label>
      </header>

      {mode === 'all' && (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div role="tablist" aria-label="Filter by status" className="glass inline-flex gap-0.5 rounded-full p-1">
            {FILTERS.map((f) => {
              const active = (state ?? 'ALL') === f;
              return (
                <button
                  key={f}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setState(f)}
                  className={clsx(
                    'focus-ring rounded-full px-3.5 py-1.5 text-[13px] whitespace-nowrap transition duration-200 ease-(--ease-spring)',
                    active ? 'bg-[var(--frost)] font-medium shadow-sm' : 'text-ink-2 hover:text-ink',
                  )}
                >
                  {f === 'ALL' ? 'All' : STATE_META[f].label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Panel className="overflow-hidden pt-3">
        {list.data?.items.length === 0 && !list.isPending ? (
          <Empty
            icon={<Building2 className="size-6" />}
            title={dq ? `No vendors match “${dq}”` : mode === 'queue' ? 'You’re all caught up' : 'No vendors here yet'}
            body={dq ? 'Try the vendor’s legal name or its VO reference.' : 'When vendors reach this stage they’ll show up here.'}
          />
        ) : (
          <VendorList items={list.data?.items} loading={list.isPending} />
        )}
        {total > PAGE && (
          <div className="hairline flex items-center justify-between border-t px-6 py-3 text-[13px] text-ink-2">
            <span className="tabular">
              {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
