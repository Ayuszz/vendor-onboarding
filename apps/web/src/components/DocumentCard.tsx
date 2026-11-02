import { extractFields, type DocumentType, type OcrMeta, type Requirement, type VendorDTO } from '@vo/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ExternalLink, FileText, Loader2, ScanText, Trash2, UploadCloud, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { fileSize, timeAgo } from '../lib/format';
import { Button, Input, Pill, useToast } from './ui';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';
const MAX_MB = 10;

type StepState = 'todo' | 'active' | 'done' | 'skipped' | 'failed';

/** One link in the document's activity chain. */
function Step({ state, title, detail, last }: { state: StepState; title: string; detail?: ReactNode; last?: boolean }) {
  return (
    <li className="relative flex min-w-0 flex-1 gap-2.5 sm:flex-col sm:gap-2">
      {!last && (
        <span
          aria-hidden
          className={clsx(
            'absolute top-6 bottom-0 left-[11px] w-px sm:top-[11px] sm:right-0 sm:bottom-auto sm:left-7 sm:h-px sm:w-auto',
            state === 'done' || state === 'skipped' ? 'bg-ok/60' : 'bg-[var(--glass-line)]',
          )}
        />
      )}
      <span
        className={clsx(
          'relative z-10 grid size-6 shrink-0 place-items-center rounded-full',
          state === 'done' && 'bg-ok text-white',
          state === 'skipped' && 'bg-[var(--field-bg-hover)] text-ink-3',
          state === 'active' && 'bg-accent text-white',
          state === 'failed' && 'bg-bad text-white',
          state === 'todo' && 'bg-[var(--field-bg-hover)]',
        )}
        aria-hidden
      >
        {state === 'done' && <Check className="size-3.5" strokeWidth={3} />}
        {state === 'skipped' && <span className="size-1.5 rounded-full bg-current" />}
        {state === 'active' && <Loader2 className="size-3.5 animate-spin" />}
        {state === 'failed' && <X className="size-3.5" strokeWidth={3} />}
      </span>
      <span className="min-w-0 pb-3 sm:pr-3 sm:pb-0">
        <span className={clsx('block text-[13px] font-medium', state === 'todo' ? 'text-ink-3' : 'text-ink')}>{title}</span>
        {detail && <span className="block text-[12px] leading-snug text-ink-3">{detail}</span>}
      </span>
    </li>
  );
}

type Reading = { phase: 'idle' } | { phase: 'reading' } | { phase: 'done'; meta: OcrMeta } | { phase: 'failed' };

/**
 * One card per document. Each document runs the same chain:
 *   1. Upload a file → 2. Read it (PDF text or OCR) → 3. Details filled in → 4. Verified
 * Steps 2–3 happen in the browser the moment a file is chosen, so the form fills itself;
 * step 4 runs on the server after upload and re-checks everything independently.
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...doc?.fields }));
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<Reading>({ phase: 'idle' });
  const [prefilled, setPrefilled] = useState<Record<string, string>>({});
  const readToken = useRef(0);

  // Keep the form in step with the saved document when nothing is being edited.
  useEffect(() => {
    if (!file && doc) setFields({ ...doc.fields });
  }, [doc?.uploadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const edited = Object.keys(prefilled).filter((k) => (fields[k] ?? '') !== prefilled[k]);
  const dirty = !!file || type.fields.some((f) => (fields[f.key] ?? '') !== (doc?.fields[f.key] ?? ''));
  const missingRequired = type.fields.some((f) => f.required && !fields[f.key]?.trim());
  const canSave = editable && dirty && !missingRequired && (!!file || !!doc) && reading.phase !== 'reading';

  const save = useMutation({
    mutationFn: () => {
      const meta: OcrMeta | undefined =
        file && reading.phase === 'done'
          ? { ...reading.meta, edited }
          : file
            ? { method: 'none', confidence: 0, found: [], edited: [], ms: 0 }
            : undefined;
      return api.upload(vendor.id, type.key, fields, file ?? undefined, meta);
    },
    onSuccess: (v) => {
      qc.setQueryData(['vendor', vendor.id], v);
      setFile(null);
      setPrefilled({});
      setReading({ phase: 'idle' });
      toast(`${type.label} uploaded. Verifying now.`, 'info');
    },
    onError: (e) => toast(e.message, 'danger'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeDoc(vendor.id, type.key),
    onSuccess: (v) => {
      qc.setQueryData(['vendor', vendor.id], v);
      setFields({});
      setPrefilled({});
      setReading({ phase: 'idle' });
    },
    onError: (e) => toast(e.message, 'danger'),
  });

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) return toast(`Files must be under ${MAX_MB} MB`, 'danger');
    if (!ACCEPT.split(',').includes(f.type)) return toast('Upload a PDF, PNG, JPEG or WEBP file', 'danger');
    setFile(f);
    const token = ++readToken.current;
    setReading({ phase: 'reading' });
    try {
      const { readDocument } = await import('../lib/ocr');
      const r = await readDocument(f);
      if (token !== readToken.current) return;
      const ex = extractFields(type.key, r.text);
      setFields((prev) => ({ ...prev, ...ex.fields }));
      setPrefilled(ex.fields);
      setReading({ phase: 'done', meta: { method: r.method, confidence: r.confidence, found: ex.found, edited: [], ms: r.ms } });
      if (!ex.found.length) toast(`We couldn’t read the details from this file. Type them in below.`, 'info');
    } catch (err) {
      console.error('Document reading failed', err);
      if (token !== readToken.current) return;
      setReading({ phase: 'failed' });
      toast('Reading the file failed. Type the details in below.', 'info');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (editable) void pick(e.dataTransfer.files[0]);
  };

  // ── chain state: local (a new file is being prepared) or saved (from the server) ──
  const local = !!file;
  const ocr: OcrMeta | null = local ? (reading.phase === 'done' ? reading.meta : null) : (doc?.ocr ?? null);
  const fieldCount = type.fields.length;

  const uploadStep: StepState = local || doc ? 'done' : 'todo';
  const uploadDetail = local ? `${file!.name} · ready to upload` : doc ? `${doc.file?.name ?? 'File'} · ${timeAgo(doc.uploadedAt)}` : 'PDF or photo, up to 10 MB';

  let readStep: StepState = 'todo';
  let readDetail: ReactNode = 'Starts when you choose a file';
  if (local && reading.phase === 'reading') {
    readStep = 'active';
    readDetail = 'Reading the document…';
  } else if (ocr && ocr.method !== 'none') {
    readStep = 'done';
    readDetail = ocr.method === 'pdf-text' ? 'Text read from the PDF' : `Scanned with OCR · ${ocr.confidence}% confidence`;
  } else if ((local && reading.phase === 'failed') || (ocr && ocr.method === 'none') || (doc && !local && !doc.ocr)) {
    readStep = 'skipped';
    readDetail = 'Not readable · typed in manually';
  }

  let fillStep: StepState = 'todo';
  let fillDetail: ReactNode = `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} to fill`;
  if (readStep === 'active') {
    fillDetail = 'Waiting for the text';
  } else if (local || doc) {
    const found = ocr?.found.length ?? 0;
    const editedN = local ? edited.length : (ocr?.edited.length ?? 0);
    fillStep = missingRequired ? 'active' : 'done';
    fillDetail =
      found > 0
        ? `${found} of ${fieldCount} filled from the document${editedN ? ` · ${editedN} edited` : ''}`
        : missingRequired
          ? 'Fill in the details below'
          : 'Filled in manually';
    if (missingRequired && local) fillStep = 'todo';
  }

  let verifyStep: StepState = 'todo';
  let verifyDetail: ReactNode = 'Runs automatically after upload';
  if (!local && doc) {
    if (doc.status === 'PENDING') {
      verifyStep = 'active';
      verifyDetail = 'Checking format, checksums and matches…';
    } else if (doc.status === 'VERIFIED') {
      verifyStep = 'done';
      verifyDetail = doc.derived.bankName ?? (doc.derived.stateCode ? `Registered in state ${doc.derived.stateCode}` : 'All checks passed');
    } else {
      verifyStep = 'failed';
      verifyDetail = `${doc.reasons.length} ${doc.reasons.length === 1 ? 'issue' : 'issues'} to fix`;
    }
  }

  return (
    <article
      aria-label={type.label}
      className={clsx(
        'frost rounded-(--radius-panel) p-4 transition-shadow sm:p-5',
        !local && doc?.status === 'FAILED' && 'ring-1 ring-bad/40',
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
          <h3 className="flex flex-wrap items-center gap-2 text-[16px] font-semibold">
            {type.label}
            {requirement === 'optional' && <Pill>Optional</Pill>}
          </h3>
          <p className="mt-0.5 text-[13px] text-ink-2">{type.hint}</p>
        </div>
        {!local && doc?.status === 'VERIFIED' && <Pill tone="success" dot>Verified</Pill>}
        {!local && doc?.status === 'FAILED' && <Pill tone="danger" dot>Needs attention</Pill>}
        {!local && doc?.status === 'PENDING' && <Pill tone="info" dot>Verifying</Pill>}
      </header>

      <ol className="mt-4 flex flex-col sm:flex-row" aria-label={`${type.label} progress`}>
        <Step state={uploadStep} title="Upload" detail={uploadDetail} />
        <Step state={readStep} title="Read document" detail={readDetail} />
        <Step state={fillStep} title="Details filled" detail={fillDetail} />
        <Step state={verifyStep} title="Verification" detail={verifyDetail} last />
      </ol>

      {!local && doc?.status === 'FAILED' && doc.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-(--radius-control) bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {doc.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {(local || doc || editable) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {type.fields.map((f) => {
            const fromDoc = f.key in prefilled;
            const changed = fromDoc && (fields[f.key] ?? '') !== prefilled[f.key];
            return (
              <label key={f.key} className="flex flex-col gap-1.5">
                <span className="flex items-center gap-2 text-[12px] font-medium text-ink-2">
                  {f.label}
                  {f.required && editable && !fromDoc && <span className="font-normal text-ink-3">(required)</span>}
                  {fromDoc && (
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium',
                        changed ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok',
                      )}
                    >
                      <ScanText className="size-3" aria-hidden />
                      {changed ? 'Edited' : 'From document'}
                    </span>
                  )}
                </span>
                {editable ? (
                  <Input
                    type={f.type === 'date' ? 'date' : 'text'}
                    inputMode={f.type === 'number' ? 'numeric' : undefined}
                    value={fields[f.key] ?? ''}
                    placeholder={reading.phase === 'reading' ? 'Reading…' : f.placeholder ? `e.g. ${f.placeholder}` : undefined}
                    autoCapitalize={f.normalize ? 'characters' : undefined}
                    spellCheck={false}
                    disabled={reading.phase === 'reading'}
                    onChange={(e) => setFields((s) => ({ ...s, [f.key]: f.normalize ? e.target.value.toUpperCase() : e.target.value }))}
                    className={clsx(f.normalize && 'tabular tracking-wide uppercase', fromDoc && !changed && 'ring-1 ring-ok/30')}
                  />
                ) : (
                  <span className="tabular py-1 text-[15px]">{doc?.fields[f.key] || '—'}</span>
                )}
              </label>
            );
          })}
        </div>
      )}

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
            <input ref={fileRef} type="file" accept={ACCEPT} className="sr-only" aria-label={`Choose a file for ${type.label}`} onChange={(e) => void pick(e.target.files?.[0])} />
            <Button size="sm" variant="ghost" icon={<UploadCloud className="size-4" />} onClick={() => fileRef.current?.click()}>
              {doc?.file || file ? 'Replace file' : 'Choose file'}
            </Button>
            <span className="hidden text-[12px] text-ink-3 sm:inline">or drop it here</span>
            <div className="ml-auto flex gap-2">
              {doc && !file && (
                <Button size="sm" variant="ghost" aria-label={`Remove ${type.label}`} className="!px-2" loading={remove.isPending} onClick={() => remove.mutate()}>
                  <Trash2 className="size-4" />
                </Button>
              )}
              {file && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    readToken.current++;
                    setFile(null);
                    setPrefilled({});
                    setReading({ phase: 'idle' });
                    setFields({ ...doc?.fields });
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button size="sm" variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
                {file ? 'Upload and verify' : 'Save changes'}
              </Button>
            </div>
          </>
        )}
      </footer>
    </article>
  );
}
