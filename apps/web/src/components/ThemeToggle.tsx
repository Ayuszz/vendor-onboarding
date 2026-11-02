import clsx from 'clsx';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePref } from '../lib/theme';

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Auto', Icon: Monitor },
];

/** Light / Dark / Auto switch. `compact` shows icons only. */
export function ThemeToggle({ compact = false, className }: { compact?: boolean; className?: string }) {
  const [pref, setPref] = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className={clsx('inline-flex rounded-full bg-[var(--field-bg)] p-0.5', className)}>
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = pref === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={value === 'system' ? 'Match my device' : `${label} theme`}
            onClick={() => setPref(value)}
            className={clsx(
              'focus-ring inline-flex items-center justify-center gap-1.5 rounded-full text-[12px] transition duration-200 ease-(--ease-spring)',
              compact ? 'size-7' : 'h-7 flex-1 px-2.5',
              active ? 'bg-[var(--frost)] font-medium text-ink shadow-sm' : 'text-ink-3 hover:text-ink',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {!compact && label}
          </button>
        );
      })}
    </div>
  );
}
