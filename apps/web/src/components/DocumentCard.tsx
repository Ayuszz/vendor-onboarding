import type { DocumentDTO, DocumentType, Requirement, VendorDTO } from '@vo/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, CircleDashed, ExternalLink, FileText, Loader2, Trash2, UploadCloud, XCircle } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';
import { api } from '../lib/api';
import { fileSize } from '../lib/format';
import { Button, Input, Pill, useToast } from './ui';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';
const MAX_MB = 10;

function StatusLine({ doc }: { doc: DocumentDTO | undefined }) {
  if (!doc) return <span className="flex items-center gap-1.5 text-[13px] text-ink-3"><CircleDashed className="size-4" /> Not uploaded</span>;
  if (doc.status === 'PENDING')
    return <span className="flex items-center gap-1.5 text-[13px] text-info"><Loader2 className="size-4 animate-spin" /> Verifying…</span>;
  if (doc.status === 'VERIFIED')
    return <span className="flex items-center gap-1.5 text-[13px] text-ok"><CheckCircle2 className="size-4" /> Verified</span>;
  return <span className="flex items-center gap-1.5 text-[13px] text-bad"><XCircle className="size-4" /> Needs attention</span>;
}

/**
 * One card per document type, driven entirely by the shared registry: fields,
 * requirement and verification messages all come from config.
 */
export function DocumentCard({
  vendor,
  type,
  requirement,
  editable,
}: {
  vendor: VendorDTO;
  type: DocumentType;
  requirement: Requirement;
  editable: boolean;
}) {
  const doc = vendor.documents.find((d) => d.key === type.key);
  const qc = useQueryClient();
  const toast = useToast();
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...doc?.fields }));
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const dirty = !!file || type.fields.some((f) => (fields[f.key] ?? '') !== (doc?.fields[f.key] ?? ''));

  const save = useMutation({
    mutationFn: () => api.upload(vendor.id, type.key, fields, file ?? undefined),
    onSuccess: (v) => {
      qc.setQueryData(['vendor', vendor.id], v);
      setFile(null);
      toast(`${type.label} saved — verifying now`, 'info');
    },
    onError: (e) => toast(e.message, 'danger'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeDoc(vendor.id, type.key),
    onSuccess: (v) => {
      qc.setQueryData(['vendor', vendor.id], v);
      setFields({});
    },
    onError: (e) => toast(e.message, 'danger'),
  });

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) return toast(`Files must be under ${MAX_MB} MB`, 'danger');
    if (!ACCEPT.split(',').includes(f.type)) return toast('Upload a PDF, PNG, JPEG or WEBP file', 'danger');
    setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (editable) pick(e.dataTransfer.files[0]);
  };

  const missingRequired = type.fields.some((f) => f.required && !fields[f.key]?.trim());
  const canSave = editable && dirty && !missingRequired && (!!file || !!doc);

  return (
    <article
      className={clsx(
        'frost rounded-(--radius-panel) p-4 transition-shadow sm:p-5',
        doc?.status === 'FAILED' && 'ring-1 ring-bad/40',
        dragging && 'ring-2 ring-accent',
      )}
      onDragOver={(e) => {
        if (!editable) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {type.label}
            {requirement === 'optional' && <Pill>Optional</Pill>}
          </h3>
          <p className="mt-0.5 text-[13px] text-ink-2">{type.hint}</p>
        </div>
        <StatusLine doc={doc} />
      </header>

      {doc?.status === 'FAILED' && doc.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-(--radius-control) bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {doc.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {doc?.derived && Object.keys(doc.derived).length > 0 && doc.status === 'VERIFIED' && (
        <p className="mt-3 text-[13px] text-ink-2">
          {doc.derived.bankName ? `Bank: ${doc.derived.bankName}` : doc.derived.bankCode ? `Bank code: ${doc.derived.bankCode}` : null}
          {doc.derived.stateCode ? `Registered in state code ${doc.derived.stateCode}` : null}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {type.fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">
              {f.label}
              {f.required && editable && <span className="text-ink-3"> (required)</span>}
            </span>
            {editable ? (
              <Input
                type={f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'number' ? 'numeric' : undefined}
                value={fields[f.key] ?? ''}
                placeholder={f.placeholder ? `e.g. ${f.placeholder}` : undefined}
                autoCapitalize={f.normalize ? 'characters' : undefined}
                spellCheck={false}
                onChange={(e) => setFields((s) => ({ ...s, [f.key]: f.normalize ? e.target.value.toUpperCase() : e.target.value }))}
                className={clsx(f.normalize && 'tabular tracking-wide uppercase')}
              />
            ) : (
              <span className="tabular py-1 text-[15px]">{doc?.fields[f.key] || '—'}</span>
            )}
          </label>
        ))}
      </div>

      <footer className="mt-4 flex flex-wrap items-center gap-2">
        {doc?.file && !file && (
          <button
            onClick={() => api.openFile(vendor.id, type.key).catch((e: Error) => toast(e.message, 'danger'))}
            className="focus-ring flex min-w-0 items-center gap-2 rounded-full bg-[var(--field-bg)] py-1.5 pr-3 pl-2.5 text-[13px] hover:bg-[var(--field-bg-hover)]"
          >
            <FileText className="size-4 shrink-0 text-ink-3" />
            <span className="truncate">{doc.file.name}</span>
            <span className="text-ink-3">{fileSize(doc.file.size)}</span>
            <ExternalLink className="size-3.5 text-ink-3" aria-hidden />
          </button>
        )}
        {file && (
          <span className="flex min-w-0 items-center gap-2 rounded-full bg-accent-soft py-1.5 pr-3 pl-2.5 text-[13px] text-accent">
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{file.name}</span>
            <span>{fileSize(file.size)}</span>
          </span>
        )}

        {editable && (
          <>
            <input
              id={inputId}
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => pick(e.target.files?.[0])}
            />
            <Button size="sm" variant="ghost" icon={<UploadCloud className="size-4" />} onClick={() => fileRef.current?.click()}>
              {doc?.file || file ? 'Replace file' : 'Choose file'}
            </Button>
            <span className="hidden text-[12px] text-ink-3 sm:inline">or drop it here</span>
            <div className="ml-auto flex gap-2">
              {doc && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${type.label}`}
                  className="!px-2"
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
              <Button size="sm" variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
                {doc ? 'Save changes' : 'Upload'}
              </Button>
            </div>
          </>
        )}
      </footer>
    </article>
  );
}
