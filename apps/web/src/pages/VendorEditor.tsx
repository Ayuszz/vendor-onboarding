import {
  CATEGORIES,
  CATEGORY_LABELS,
  CONSTITUTIONS,
  CONSTITUTION_LABELS,
  applicableDocuments,
  addressSchema,
  bankSchema,
  contactSchema,
  resolveBank,
  vendorProfileSchema,
  type VendorDTO,
  type VendorDraft,
} from '@vo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertCircle, Check, CheckCircle2, ChevronLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { DocumentCard } from '../components/DocumentCard';
import { Button, Field, Input, Panel, Select, Skeleton, Toggle, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const STEPS = ['Company', 'Contact & address', 'Bank', 'Documents', 'Review'] as const;

const companySchema = vendorProfileSchema.pick({ legalName: true, constitution: true, category: true });
const stepSchemas: (z.ZodType | null)[] = [
  companySchema,
  z.object({ contact: contactSchema, address: addressSchema }),
  z.object({ bank: bankSchema }),
  null,
  null,
];

type Errors = Record<string, string>;
function validate(step: number, form: VendorDraft): Errors {
  const schema = stepSchemas[step];
  if (!schema) return {};
  const r = schema.safeParse(form);
  if (r.success) return {};
  const out: Errors = {};
  for (const i of r.error.issues) out[i.path.join('.')] ??= i.message;
  return out;
}

export default function VendorEditor() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { isVendor, vendorId: myVendorId, refresh, user } = useAuth();
  const step = Math.min(Math.max(Number(params.get('step') ?? 0), 0), STEPS.length - 1);

  const vendor = useQuery({
    queryKey: ['vendor', id],
    queryFn: () => api.get(id!),
    enabled: !!id,
    // Poll while any document is being verified so status updates appear on their own.
    refetchInterval: (q) => (q.state.data?.documents.some((d) => d.status === 'PENDING') ? 1500 : false),
  });

  const [form, setForm] = useState<VendorDraft>(() => ({
    isMsme: false,
    isImportExport: false,
    isFoodBusiness: false,
    paymentTermsDays: 30,
    ...(isVendor && user ? { contact: { email: user.email } } : {}),
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [loadedId, setLoadedId] = useState<string | null>(null);

  useEffect(() => {
    if (vendor.data && loadedId !== vendor.data.id) {
      setForm(vendor.data.profile);
      setLoadedId(vendor.data.id);
    }
  }, [vendor.data, loadedId]);

  const editable = !id || !!vendor.data?.allowedActions.includes('submit') || ['DRAFT', 'SENT_BACK'].includes(vendor.data?.state ?? '');

  const save = useMutation({
    mutationFn: async (): Promise<VendorDTO> =>
      id ? api.update(id, form, vendor.data?.version) : api.create(form),
    onSuccess: (v) => {
      qc.setQueryData(['vendor', v.id], v);
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      if (isVendor && !id) void refresh();
    },
  });

  const submit = useMutation({
    mutationFn: () => api.act(id!, 'submit', { version: vendor.data?.version }),
    onSuccess: (v) => {
      qc.setQueryData(['vendor', v.id], v);
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      toast(isVendor ? 'Application submitted' : 'Submitted for QC and SCM review');
      navigate(`/vendors/${v.id}`);
    },
    onError: (e) => toast(e.message, 'danger'),
  });

  const goTo = (s: number, vid = id) => {
    if (vid && vid !== id) navigate(`/vendors/${vid}/edit?step=${s}`, { replace: true });
    else setParams({ step: String(s) }, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const next = async () => {
    const errs = validate(step, form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (step <= 2) {
      try {
        const v = await save.mutateAsync();
        goTo(step + 1, v.id);
      } catch (e) {
        toast((e as Error).message, 'danger');
      }
    } else goTo(step + 1);
  };

  const set = <K extends keyof VendorDraft>(k: K, v: VendorDraft[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setIn = <K extends 'contact' | 'address' | 'bank'>(k: K, field: string, v: string) =>
    setForm((f) => ({ ...f, [k]: { ...f[k], [field]: v } }));

  const docs = useMemo(() => applicableDocuments(form), [form]);
  const bank = form.bank?.ifsc ? resolveBank(form.bank.ifsc) : null;

  // A vendor who already has an application never starts a second one.
  if (isVendor && !id && myVendorId) {
    navigate(`/vendors/${myVendorId}/edit`, { replace: true });
    return null;
  }
  if (id && vendor.isPending) return <Skeleton className="h-96 w-full" />;
  if (id && vendor.data && !editable) {
    navigate(`/vendors/${id}`, { replace: true });
    return null;
  }

  return (
    <div className="mx-auto max-w-[880px] space-y-5">
      <header className="flex items-center gap-3 px-1 pt-2">
        {(id || !isVendor) && (
          <Button variant="ghost" size="sm" className="!px-2" aria-label="Back" onClick={() => navigate(id ? `/vendors/${id}` : '/')}>
            <ChevronLeft className="size-5" />
          </Button>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[28px] leading-tight font-semibold tracking-[-0.025em]">
            {form.legalName || (isVendor ? 'Register your company' : 'New vendor')}
          </h1>
          <p className="text-[13px] text-ink-3">
            {vendor.data ? `${vendor.data.reference} · ` : ''}
            {save.isPending ? 'Saving…' : vendor.data ? 'Draft saved' : 'Not saved yet'}
          </p>
        </div>
      </header>

      {isVendor && !id && (
        <p className="px-1 text-[15px] text-ink-2">
          Welcome. Tell us about your company, add your bank details, then upload your documents. Your progress is saved at every
          step, so you can stop and come back anytime.
        </p>
      )}

      {vendor.data?.state === 'SENT_BACK' && <SentBackNote vendorId={vendor.data.id} />}

      {/* Stepper — a real sequence, so numbered. */}
      <nav aria-label="Steps" className="glass rounded-full p-1.5">
        <ol className="flex">
          {STEPS.map((label, i) => {
            const reachable = i === 0 || !!id;
            const done = i < step;
            return (
              <li key={label} className="flex-1">
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => reachable && goTo(i)}
                  aria-current={i === step ? 'step' : undefined}
                  className={clsx(
                    'focus-ring flex w-full items-center justify-center gap-2 rounded-full px-2 py-2 text-[13px] transition duration-300 ease-(--ease-spring)',
                    i === step ? 'bg-[var(--frost)] font-semibold shadow-sm' : 'text-ink-2 enabled:hover:text-ink',
                    !reachable && 'opacity-40',
                  )}
                >
                  <span
                    className={clsx(
                      'tabular grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                      done ? 'bg-ok text-white' : i === step ? 'bg-accent text-white' : 'bg-[var(--field-bg-hover)]',
                    )}
                  >
                    {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={clsx(i === step ? 'inline' : 'hidden md:inline')}>{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <Panel className="p-5 sm:p-7" key={step}>
        <div className="animate-rise">
          {step === 0 && (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Legal name" hint="Exactly as it appears on the GST certificate" error={errors.legalName} className="sm:col-span-2">
                {(fid, d) => (
                  <Input id={fid} aria-describedby={d} aria-invalid={!!errors.legalName} value={form.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} autoFocus />
                )}
              </Field>
              <Field label="Trade name" hint="Optional" className="sm:col-span-2">
                {(fid) => <Input id={fid} value={form.tradeName ?? ''} onChange={(e) => set('tradeName', e.target.value)} />}
              </Field>
              <Field label="Constitution" error={errors.constitution}>
                {(fid) => (
                  <Select id={fid} aria-invalid={!!errors.constitution} value={form.constitution ?? ''} onChange={(e) => set('constitution', (e.target.value || undefined) as VendorDraft['constitution'])}>
                    <option value="">Choose…</option>
                    {CONSTITUTIONS.map((c) => (
                      <option key={c} value={c}>{CONSTITUTION_LABELS[c]}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="What they supply" error={errors.category}>
                {(fid) => (
                  <Select id={fid} aria-invalid={!!errors.category} value={form.category ?? ''} onChange={(e) => set('category', (e.target.value || undefined) as VendorDraft['category'])}>
                    <option value="">Choose…</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="hairline divide-y divide-[var(--glass-line)] rounded-(--radius-control) border px-4 sm:col-span-2">
                <Toggle checked={!!form.isMsme} onChange={(v) => set('isMsme', v)} label="Registered MSME" description="Adds the Udyam certificate" />
                <Toggle checked={!!form.isFoodBusiness} onChange={(v) => set('isFoodBusiness', v)} label="Food business operator" description="Adds the FSSAI license" />
                <Toggle checked={!!form.isImportExport} onChange={(v) => set('isImportExport', v)} label="Imports or exports" description="Adds IEC, AD code and RCMC" />
              </div>
              <Field label="Payment terms (days)">
                {(fid) => (
                  <Input id={fid} type="number" min={0} max={180} inputMode="numeric" value={form.paymentTermsDays ?? 30} onChange={(e) => set('paymentTermsDays', Number(e.target.value))} />
                )}
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-7">
              <fieldset className="grid gap-5 sm:grid-cols-3">
                <legend className="mb-4 text-[17px] font-semibold">Primary contact</legend>
                <Field label="Name" error={errors['contact.name']}>
                  {(fid) => <Input id={fid} autoComplete="name" value={form.contact?.name ?? ''} onChange={(e) => setIn('contact', 'name', e.target.value)} aria-invalid={!!errors['contact.name']} />}
                </Field>
                <Field label="Email" error={errors['contact.email']}>
                  {(fid, d) => (
                    <Input
                      id={fid}
                      type="email"
                      autoComplete="email"
                      value={form.contact?.email ?? ''}
                      onChange={(e) => setIn('contact', 'email', e.target.value)}
                      aria-invalid={!!errors['contact.email']}
                      aria-describedby={d}
                      readOnly={isVendor}
                      title={isVendor ? 'This is the email you sign in with' : undefined}
                    />
                  )}
                </Field>
                <Field label="Mobile" error={errors['contact.phone']}>
                  {(fid) => <Input id={fid} type="tel" inputMode="numeric" autoComplete="tel-national" value={form.contact?.phone ?? ''} onChange={(e) => setIn('contact', 'phone', e.target.value.replace(/\D/g, '').slice(0, 10))} aria-invalid={!!errors['contact.phone']} />}
                </Field>
              </fieldset>
              <fieldset className="grid gap-5 sm:grid-cols-6">
                <legend className="mb-4 text-[17px] font-semibold">Registered address</legend>
                <Field label="Address line 1" error={errors['address.line1']} className="sm:col-span-6">
                  {(fid) => <Input id={fid} autoComplete="address-line1" value={form.address?.line1 ?? ''} onChange={(e) => setIn('address', 'line1', e.target.value)} aria-invalid={!!errors['address.line1']} />}
                </Field>
                <Field label="Address line 2" hint="Optional" className="sm:col-span-6">
                  {(fid) => <Input id={fid} autoComplete="address-line2" value={form.address?.line2 ?? ''} onChange={(e) => setIn('address', 'line2', e.target.value)} />}
                </Field>
                <Field label="City" error={errors['address.city']} className="sm:col-span-2">
                  {(fid) => <Input id={fid} autoComplete="address-level2" value={form.address?.city ?? ''} onChange={(e) => setIn('address', 'city', e.target.value)} aria-invalid={!!errors['address.city']} />}
                </Field>
                <Field label="State" error={errors['address.state']} className="sm:col-span-2">
                  {(fid) => <Input id={fid} autoComplete="address-level1" value={form.address?.state ?? ''} onChange={(e) => setIn('address', 'state', e.target.value)} aria-invalid={!!errors['address.state']} />}
                </Field>
                <Field label="PIN code" error={errors['address.pincode']} className="sm:col-span-2">
                  {(fid) => <Input id={fid} inputMode="numeric" autoComplete="postal-code" value={form.address?.pincode ?? ''} onChange={(e) => setIn('address', 'pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} aria-invalid={!!errors['address.pincode']} />}
                </Field>
              </fieldset>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Account holder name" error={errors['bank.accountHolder']} className="sm:col-span-2">
                {(fid) => <Input id={fid} value={form.bank?.accountHolder ?? ''} onChange={(e) => setIn('bank', 'accountHolder', e.target.value)} aria-invalid={!!errors['bank.accountHolder']} />}
              </Field>
              <Field label="Account number" error={errors['bank.accountNumber']}>
                {(fid) => <Input id={fid} inputMode="numeric" className="tabular" value={form.bank?.accountNumber ?? ''} onChange={(e) => setIn('bank', 'accountNumber', e.target.value.replace(/\D/g, '').slice(0, 18))} aria-invalid={!!errors['bank.accountNumber']} />}
              </Field>
              <Field
                label="IFSC"
                error={errors['bank.ifsc']}
                hint={bank ? (bank.name ? `${bank.name} — bank code ${bank.code}` : `Bank code ${bank.code}`) : 'We look up the bank from the IFSC'}
              >
                {(fid, d) => (
                  <Input id={fid} aria-describedby={d} spellCheck={false} className="tabular tracking-wide uppercase" value={form.bank?.ifsc ?? ''} onChange={(e) => setIn('bank', 'ifsc', e.target.value.toUpperCase().slice(0, 11))} aria-invalid={!!errors['bank.ifsc']} />
                )}
              </Field>
              <p className="text-[13px] text-ink-2 sm:col-span-2">
                These must match the cancelled cheque or bank letter you upload in the next step.
              </p>
            </div>
          )}

          {step === 3 && vendor.data && (
            <div className="space-y-3">
              <p className="text-[14px] text-ink-2">
                Each document is checked automatically after upload — formats, checksums and that numbers match each other and your profile.
              </p>
              {docs
                .filter((d) => d.requirement === 'required')
                .map(({ doc, requirement }) => (
                  <DocumentCard key={doc.key} vendor={vendor.data} type={doc} requirement={requirement} editable={editable} />
                ))}
              {docs.some((d) => d.requirement === 'optional') && (
                <details className="group pt-2" open={vendor.data.documents.some((d) => docs.find((x) => x.doc.key === d.key)?.requirement === 'optional')}>
                  <summary className="focus-ring cursor-pointer list-none rounded-(--radius-control) px-1 py-2 text-[15px] font-medium text-accent">
                    <span className="group-open:hidden">Add optional documents</span>
                    <span className="hidden group-open:inline">Optional documents</span>
                  </summary>
                  <div className="mt-2 space-y-3">
                    {docs
                      .filter((d) => d.requirement === 'optional')
                      .map(({ doc, requirement }) => (
                        <DocumentCard key={doc.key} vendor={vendor.data} type={doc} requirement={requirement} editable={editable} />
                      ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {step === 4 && vendor.data && (
            <div>
              {vendor.data.blockers.length === 0 ? (
                <div className="flex flex-col items-center py-6 text-center">
                  <CheckCircle2 className="size-12 text-ok" />
                  <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.015em]">Ready to submit</h2>
                  <p className="mt-1 max-w-md text-[14px] text-ink-2">
                    {isVendor
                      ? 'Our quality and supply-chain teams review it first, then finance gives final approval. We’ll keep this page updated at every step.'
                      : 'QC and SCM review in parallel, then Finance approves and the vendor is created in SAP automatically.'}
                  </p>
                </div>
              ) : (
                <div>
                  <h2 className="text-[19px] font-semibold">Before you can submit</h2>
                  <ul className="mt-3 space-y-2">
                    {vendor.data.blockers.map((b) => (
                      <li key={b} className="flex items-start gap-2.5 text-[14px]">
                        <AlertCircle className="mt-0.5 size-4 shrink-0 text-warn" /> {b}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>

      <div className="flex items-center justify-between gap-2 px-1">
        <Button variant="ghost" disabled={step === 0} onClick={() => goTo(step - 1)}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button variant="primary" size="lg" loading={save.isPending} onClick={next}>
            {step <= 2 ? 'Save and continue' : 'Continue'}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            disabled={!vendor.data || vendor.data.blockers.length > 0}
            loading={submit.isPending}
            onClick={() => submit.mutate()}
          >
            Submit for approval
          </Button>
        )}
      </div>
      {id && (
        <p className="text-center text-[13px] text-ink-3">
          <Link to={`/vendors/${id}`} className="focus-ring rounded hover:text-ink-2">
            View activity for this vendor
          </Link>
        </p>
      )}
    </div>
  );
}

function SentBackNote({ vendorId }: { vendorId: string }) {
  const events = useQuery({ queryKey: ['events', vendorId], queryFn: () => api.events(vendorId) });
  const last = events.data?.filter((e) => e.action === 'send_back').at(-1);
  if (!last) return null;
  return (
    <div className="glass flex gap-3 rounded-(--radius-panel) border-warn/40 p-4">
      <AlertCircle className="size-5 shrink-0 text-warn" />
      <div className="text-[14px]">
        <p className="font-semibold">Sent back by {last.actorName}</p>
        <p className="mt-0.5 text-ink-2">{last.reason}</p>
      </div>
    </div>
  );
}
