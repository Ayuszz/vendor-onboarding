import { CATEGORY_LABELS, ROLE_LABELS, type Category, type VendorListItem } from '@vo/shared';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { timeAgo } from '../lib/format';
import { Skeleton, StatePill } from './ui';

function DocMeter({ verified, required }: { verified: number; required: number }) {
  const pct = required ? Math.round((verified / required) * 100) : 0;
  return (
    <div className="flex items-center gap-2" title={`${verified} of ${required} required documents verified`}>
      <div className="h-1 w-14 overflow-hidden rounded-full bg-[var(--field-bg-hover)]">
        <div className={clsx('h-full rounded-full', pct === 100 ? 'bg-ok' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular text-[12px] text-ink-3">
        {verified}/{required}
      </span>
    </div>
  );
}

/** Responsive list: a table on wide screens, stacked rows on phones. Rows are links. */
export function VendorList({ items, loading }: { items: VendorListItem[] | undefined; loading: boolean }) {
  if (loading)
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  return (
    <div role="table" aria-label="Vendors" className="text-[14px]">
      <div
        role="row"
        className="hairline hidden grid-cols-[minmax(0,2.2fr)_1.1fr_1.1fr_0.9fr_0.8fr_20px] gap-4 border-b px-6 pb-2 text-[12px] text-ink-3 md:grid"
      >
        <span role="columnheader">Vendor</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Waiting on</span>
        <span role="columnheader">Documents</span>
        <span role="columnheader">Updated</span>
        <span />
      </div>
      {items?.map((v) => (
        <Link
          key={v.id}
          to={`/vendors/${v.id}`}
          role="row"
          className="focus-ring hairline group grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 border-b px-5 py-3.5 transition-colors last:border-0 hover:bg-[var(--field-bg)] md:grid-cols-[minmax(0,2.2fr)_1.1fr_1.1fr_0.9fr_0.8fr_20px] md:px-6"
        >
          <span role="cell" className="min-w-0">
            <span className="block truncate font-medium">{v.legalName}</span>
            <span className="tabular block truncate text-[12px] text-ink-3">
              {v.reference}
              {v.category ? ` · ${CATEGORY_LABELS[v.category as Category] ?? v.category}` : ''}
            </span>
          </span>
          <span role="cell" className="justify-self-end md:justify-self-start">
            <StatePill state={v.state} />
          </span>
          <span role="cell" className="text-[13px] text-ink-2">
            {v.pendingWith.length ? v.pendingWith.map((r) => ROLE_LABELS[r].split(' ')[0]).join(' & ') : '—'}
          </span>
          <span role="cell" className="justify-self-end md:justify-self-start">
            <DocMeter {...v.docs} />
          </span>
          <span role="cell" className="hidden text-[13px] text-ink-3 md:block">
            {timeAgo(v.updatedAt)}
          </span>
          <ChevronRight className="hidden size-4 text-ink-3 transition-transform group-hover:translate-x-0.5 md:block" aria-hidden />
        </Link>
      ))}
    </div>
  );
}
