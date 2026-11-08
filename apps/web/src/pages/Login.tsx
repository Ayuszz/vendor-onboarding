import clsx from 'clsx';
import { ArrowLeft, Mail } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';
import { Button, Field, Input, Logo } from '../components/ui';
import { IS_DEMO, api } from '../lib/api';
import { useAuth } from '../lib/auth';

type Tab = 'vendor' | 'staff';
const SHOW_DEV_HINTS = IS_DEMO || import.meta.env.DEV;

/**
 * One sign-in page for everyone.
 * - Vendors: email → 6-digit code (no password). First sign-in creates the account;
 *   if the company already exists in the database it is linked automatically.
 * - Staff: email + password.
 */
export default function Login() {
  const [tab, setTab] = useState<Tab>('vendor');
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="scene" aria-hidden>
        <i />
      </div>
      <div className="glass animate-rise w-full max-w-[420px] rounded-(--radius-window) p-7 sm:p-8">
        <div className="mb-5 flex items-start justify-between">
          <Logo className="size-12" />
          <ThemeToggle compact />
        </div>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-balance">
          {tab === 'vendor' ? 'Vendor portal' : 'Employee sign-in'}
        </h1>
        <p className="mt-2 text-[15px] text-ink-2">
          {tab === 'vendor'
            ? 'Sign in with your work email to register your company or check your application.'
            : 'For QC, SCM, Finance and procurement teams.'}
        </p>

        <div role="tablist" aria-label="Account type" className="mt-6 grid grid-cols-2 rounded-full bg-[var(--field-bg)] p-1">
          {(['vendor', 'staff'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={clsx(
                'focus-ring rounded-full py-2 text-[14px] transition duration-200 ease-(--ease-spring)',
                tab === t ? 'bg-[var(--frost)] font-semibold shadow-sm' : 'text-ink-2 hover:text-ink',
              )}
            >
              {t === 'vendor' ? 'Vendor' : 'Employee'}
            </button>
          ))}
        </div>

        <div className="mt-6">{tab === 'vendor' ? <VendorSignIn /> : <StaffSignIn />}</div>

        {IS_DEMO && (
          <p className="mt-6 text-[12px] leading-relaxed text-ink-3">
            Demo: runs in your browser with sample data. No emails are sent and changes reset when you reload.
          </p>
        )}
      </div>
    </div>
  );
}

function VendorSignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter a valid email address');
    setBusy(true);
    try {
      const r = await api.requestCode(email.trim());
      if (IS_DEMO && r.devCode) {
        // The public demo has no mail server, so it skips the code step instead of showing the code.
        signIn(await api.verifyCode(email.trim(), r.devCode));
        return;
      }
      setDevCode(r.devCode ?? null);
      setStep('code');
      setCode('');
      setResendIn(30);
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!/^[0-9]{6}$/.test(code)) return setError('Enter the 6-digit code');
    setBusy(true);
    try {
      signIn(await api.verifyCode(email.trim(), code));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (step === 'email')
    return (
      <form onSubmit={send} className="flex flex-col gap-4" noValidate>
        <Field label="Work email" error={error ?? undefined}>
          {(id, d) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={d}
              aria-invalid={!!error}
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} icon={<Mail className="size-[18px]" />}>
          {IS_DEMO ? 'Continue' : 'Email me a sign-in code'}
        </Button>
        {IS_DEMO && (
          <p className="text-[13px] text-ink-2">
            Sign-in codes are switched off on this public demo because it has no mail server. The real app emails a code and never
            shows it on screen. Try <b className="font-medium text-ink">accounts@deccan.in</b> to see a vendor that already exists, or
            any other email to register a new one.
          </p>
        )}
      </form>
    );

  return (
    <form onSubmit={verify} className="flex flex-col gap-4" noValidate>
      <p className="text-[14px] text-ink-2">
        We sent a 6-digit code to <span className="font-medium text-ink">{email.trim()}</span>. It expires in 10 minutes.
      </p>
      {devCode && (
        <p className="rounded-(--radius-control) bg-accent-soft px-3 py-2 text-[13px] text-accent">
          Testing mode (DEV_SHOW_OTP is on): your code is{' '}
          <b className="tabular font-semibold tracking-widest">{devCode}</b>
        </p>
      )}
      <Field label="Sign-in code" error={error ?? undefined}>
        {(id, d) => (
          <Input
            id={id}
            ref={codeRef}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-describedby={d}
            aria-invalid={!!error}
            className="tabular text-center text-[22px] tracking-[0.5em]"
          />
        )}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
        Sign in
      </Button>
      <div className="flex items-center justify-between text-[13px]">
        <button
          type="button"
          onClick={() => {
            setStep('email');
            setError(null);
          }}
          className="focus-ring inline-flex items-center gap-1 rounded text-ink-2 hover:text-ink"
        >
          <ArrowLeft className="size-3.5" /> Use a different email
        </button>
        <button
          type="button"
          disabled={resendIn > 0 || busy}
          onClick={() => send()}
          className="focus-ring rounded font-medium text-accent disabled:font-normal disabled:text-ink-3"
        >
          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
        </button>
      </div>
    </form>
  );
}

function StaffSignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) return setError('Enter your email and password');
    setBusy(true);
    try {
      signIn(await api.staffLogin(email.trim(), password));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field label="Work email">
        {(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
      </Field>
      <Field label="Password" error={error ?? undefined}>
        {(id, d) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={d}
            aria-invalid={!!error}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={busy}>
        Sign in
      </Button>
      {SHOW_DEV_HINTS && (
        <div className="rounded-(--radius-control) bg-[var(--field-bg)] px-3 py-2.5 text-[13px] text-ink-2">
          <p className="font-medium text-ink">Sample accounts</p>
          <p className="mt-1">
            qc@example.com, scm@example.com, finance@example.com, buyer@example.com
            <br />
            Password: <span className="tabular font-medium text-ink">Demo@1234</span>
          </p>
        </div>
      )}
    </form>
  );
}
