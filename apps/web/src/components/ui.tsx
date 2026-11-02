import { STATE_META, type State, type Tone } from '@vo/shared';
import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

// ── Button ──────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white shadow-[0_6px_20px_-6px_var(--color-accent)] hover:brightness-110',
  success: 'bg-ok text-white shadow-[0_6px_20px_-6px_var(--color-ok)] hover:brightness-110',
  danger: 'bg-bad-soft text-bad hover:bg-bad hover:text-white',
  secondary: 'bg-[var(--field-bg)] text-ink hover:bg-[var(--field-bg-hover)]',
  ghost: 'text-ink-2 hover:bg-[var(--field-bg)] hover:text-ink',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'focus-ring inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition duration-200 ease-(--ease-spring) active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-10 px-4 text-[14px]',
        size === 'lg' && 'h-12 px-6 text-[15px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ── Surfaces ────────────────────────────────────────────

export function Panel({
  className,
  children,
  as: Tag = 'section',
  ...rest
}: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'aside' } & Record<string, unknown>) {
  return (
    <Tag className={clsx('glass rounded-(--radius-panel)', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function PanelHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3 sm:px-6">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Status ──────────────────────────────────────────────

const TONES: Record<Tone, string> = {
  neutral: 'bg-[var(--field-bg-hover)] text-ink-2',
  info: 'bg-info-soft text-info',
  success: 'bg-ok-soft text-ok',
  warning: 'bg-warn-soft text-warn',
  danger: 'bg-bad-soft text-bad',
};

export function Pill({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium', TONES[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export const StatePill = ({ state }: { state: State }) => (
  <Pill tone={STATE_META[state].tone} dot>
    {STATE_META[state].label}
  </Pill>
);

// ── Form controls ───────────────────────────────────────

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id, hint || error ? msgId : undefined)}
      {error ? (
        <p id={msgId} className="text-[12px] text-bad">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="text-[12px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('field', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx('field appearance-none bg-no-repeat pr-9', className)} {...rest}>
      {children}
    </select>
  );
}

/** iOS-style switch. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={clsx('flex cursor-pointer items-center justify-between gap-4 py-2', disabled && 'opacity-50')}>
      <span>
        <span className="block text-[15px]">{label}</span>
        {description && <span className="block text-[12px] text-ink-3">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'focus-ring relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200',
          checked ? 'bg-ok' : 'bg-[var(--field-bg-hover)]',
        )}
      >
        <span
          className={clsx(
            'absolute top-[2px] left-[2px] size-[27px] rounded-full bg-white shadow-[0_3px_8px_rgb(0_0_0/0.15),0_1px_1px_rgb(0_0_0/0.16)] transition-transform duration-300 ease-(--ease-spring)',
            checked && 'translate-x-[20px]',
          )}
        />
      </button>
    </label>
  );
}

// ── Dialog ──────────────────────────────────────────────

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(520px,calc(100vw-32px))] bg-transparent p-0 text-ink backdrop:bg-black/25 backdrop:backdrop-blur-sm"
    >
      {open && (
        <div className="glass-strong animate-rise rounded-(--radius-window) p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[19px] font-semibold tracking-[-0.01em]">{title}</h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="!px-2">
              <X className="size-4" />
            </Button>
          </div>
          {children}
          {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ── Toasts ──────────────────────────────────────────────

type Toast = { id: number; message: string; tone: 'success' | 'danger' | 'info' };
const ToastCtx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'glass-strong animate-rise pointer-events-auto flex max-w-md items-center gap-2.5 rounded-full py-2.5 pr-5 pl-3 text-[14px] font-medium',
            )}
          >
            <span
              className={clsx(
                'size-2 rounded-full',
                t.tone === 'success' && 'bg-ok',
                t.tone === 'danger' && 'bg-bad',
                t.tone === 'info' && 'bg-accent',
              )}
            />
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Misc ────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-(--radius-control) bg-[var(--field-bg-hover)]', className)} />;
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-full bg-accent-soft text-accent">{icon}</div>
      <h3 className="text-[17px] font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-[14px] text-ink-2">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  return (
    <span
      className={clsx('grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white', className)}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 65% 48%))` }}
      aria-hidden
    >
      {name
        .split(/\s+/)
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}

/** App mark, inlined so it renders anywhere (including single-file builds). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="vo-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5aa9ff" />
          <stop offset="1" stopColor="#0a66ff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#vo-logo)" />
      <path d="M18 33l9 9 19-20" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
