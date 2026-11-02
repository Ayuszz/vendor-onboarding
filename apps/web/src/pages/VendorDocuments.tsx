import { applicableDocuments } from '@vo/shared';
import { useQuery } from '@tanstack/react-query';
import { FileStack } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { DocumentCard } from '../components/DocumentCard';
import { Button, Empty, Panel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/** The vendor's document portal: every document with its upload → read → fill → verify chain. */
export default function VendorDocuments() {
  const { vendorId } = useAuth();
  const navigate = useNavigate();
  const vendor = useQuery({
    queryKey: ['vendor', vendorId],
    queryFn: () => api.get(vendorId!),
    enabled: !!vendorId,
    refetchInterval: (q) => (q.state.data?.documents.some((d) => d.status === 'PENDING') ? 1500 : false),
  });

  if (!vendorId)
    return (
      <Panel>
        <Empty
          icon={<FileStack className="size-6" />}
          title="Start with your company details"
          body="We need to know your company type and what you supply to show the documents that apply to you."
          action={
            <Button variant="primary" onClick={() => navigate('/application')}>
              Enter company details
            </Button>
          }
        />
      </Panel>
    );
  if (vendor.isPending || !vendor.data) return <Skeleton className="h-96" />;

  const v = vendor.data;
  const docs = applicableDocuments(v.profile);
  const required = docs.filter((d) => d.requirement === 'required');
  const optional = docs.filter((d) => d.requirement === 'optional');
  const verified = required.filter((d) => v.documents.some((x) => x.key === d.doc.key && x.status === 'VERIFIED')).length;
  const editable = v.state === 'DRAFT' || v.state === 'SENT_BACK';
  const ready = editable && v.blockers.length === 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 px-1 pt-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.025em]">Documents</h1>
          <p className="mt-1 max-w-[62ch] text-[14px] text-ink-2">
            Upload a PDF or a clear photo. We read the details from it automatically, you check them, and then we verify
            everything.
          </p>
        </div>
        <div className="glass flex items-center gap-3 self-start rounded-full py-2 pr-2 pl-4 sm:self-auto">
          <div className="leading-tight">
            <div className="tabular text-[15px] font-semibold">
              {verified} of {required.length} verified
            </div>
            <div className="text-[12px] text-ink-3">Required documents</div>
          </div>
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--field-bg-hover)]" aria-hidden>
            <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${required.length ? (verified / required.length) * 100 : 0}%` }} />
          </div>
          {ready && (
            <Button variant="primary" size="sm" onClick={() => navigate('/application?step=3')}>
              Review and submit
            </Button>
          )}
        </div>
      </header>

      {!editable && (
        <p className="glass rounded-(--radius-panel) px-4 py-3 text-[14px] text-ink-2">
          Your application has been submitted, so documents are locked while our team reviews them.
        </p>
      )}

      <section className="space-y-3" aria-label="Required documents">
        {required.map(({ doc, requirement }) => (
          <DocumentCard key={doc.key} vendor={v} type={doc} requirement={requirement} editable={editable} />
        ))}
      </section>

      {optional.length > 0 && (
        <section className="space-y-3" aria-label="Optional documents">
          <h2 className="px-1 pt-3 text-[17px] font-semibold">Optional documents</h2>
          {optional.map(({ doc, requirement }) => (
            <DocumentCard key={doc.key} vendor={v} type={doc} requirement={requirement} editable={editable} />
          ))}
        </section>
      )}
    </div>
  );
}
