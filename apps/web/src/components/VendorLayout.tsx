import { STATE_META, requiredDocumentKeys, type Tone } from '@vo/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, FileStack, FileText, Lock, LogOut, Settings as SettingsIcon } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Button, Logo } from './ui';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-3',
  info: 'text-info',
  success: 'text-ok',
  warning: 'text-warn',
  danger: 'text-bad',
};

/**
 * Vendor portal shell: sidebar + one main screen.
 * The sidebar doubles as a live summary of the application (stage, documents verified).
 */
export function VendorLayout() {
  const { user, vendorId, logout } = useAuth();
  const navigate = useNavigate();
  const vendor = useQuery({
    queryKey: ['vendor', vendorId],
    queryFn: () => api.get(vendorId!),
    enabled: !!vendorId,
    refetchInterval: (q) =>
      q.state.data?.state === 'SAP_PENDING' || q.state.data?.documents.some((d) => d.status === 'PENDING') ? 2000 : 20_000,
  });
  const v = vendor.data;
  const signOut = () => {
    navigate('/', { replace: true });
    logout();
  };

  const required = v ? requiredDocumentKeys(v.profile) : [];
  const verified = v ? required.filter((k) => v.documents.some((d) => d.key === k && d.status === 'VERIFIED')).length : 0;
  const docsFailed = v?.documents.some((d) => d.status === 'FAILED');

  const appBadge: { text: string; tone: Tone } = !v
    ? { text: 'Start here', tone: 'info' }
    : v.state === 'SENT_BACK'
      ? { text: 'Changes needed', tone: 'warning' }
      : v.state === 'DRAFT'
        ? { text: 'Initiated · in progress', tone: 'neutral' }
        : { text: 'Submitted', tone: 'success' };
  const lockedBadge = { text: 'Opens after you submit', tone: 'neutral' as Tone };
  const stage = v ? STATE_META[v.state] : null;

  // Until the application is submitted, only the Application is open.
  const unlocked = !!v && v.state !== 'DRAFT';
  const nav = [
    { to: '/application', label: 'Application', short: 'Application', icon: FileText, badge: appBadge, locked: false },
    {
      to: '/status',
      label: 'Approval status',
      short: 'Status',
      icon: Activity,
      badge: unlocked && stage ? { text: stage.label, tone: stage.tone } : lockedBadge,
      locked: !unlocked,
    },
    {
      to: '/documents',
      label: 'Documents',
      short: 'Documents',
      icon: FileStack,
      locked: !unlocked,
      badge: !unlocked
        ? lockedBadge
        : v
        ? { text: docsFailed ? 'Needs attention' : `${verified} of ${required.length} verified`, tone: (docsFailed ? 'danger' : verified === required.length ? 'success' : 'neutral') as Tone }
        : null,
    },
    { to: '/settings', label: 'Settings', short: 'Settings', icon: SettingsIcon, badge: unlocked ? null : lockedBadge, locked: !unlocked },
  ];

  return (
    <div className="min-h-dvh">
      <div className="scene" aria-hidden>
        <i />
      </div>
      <div className="mx-auto flex max-w-[1360px] gap-5 p-4 sm:p-5">
        <aside className="glass sticky top-5 hidden h-[calc(100dvh-40px)] w-[264px] shrink-0 flex-col rounded-(--radius-window) p-4 lg:flex">
          <div className="flex items-center gap-2.5 px-2 pt-1 pb-6">
            <Logo className="size-8" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[15px] font-semibold">{v?.profile.legalName || 'Vendor portal'}</div>
              <div className="truncate text-[12px] text-ink-3">{v?.reference ?? 'New registration'}</div>
            </div>
          </div>

          <nav className="flex flex-col gap-1" aria-label="Vendor portal">
            {nav.map(({ to, label, icon: Icon, badge, locked }) =>
              locked ? (
                <div
                  key={to}
                  aria-disabled="true"
                  title="Opens after you submit your application"
                  className="flex cursor-not-allowed items-start gap-3 rounded-(--radius-control) px-3 py-2.5 text-ink-3 opacity-70"
                >
                  <Icon className="mt-0.5 size-[18px] shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-[14px]">{label}</span>
                    {badge && <span className="mt-0.5 block truncate text-[12px]">{badge.text}</span>}
                  </span>
                  <Lock className="mt-0.5 size-3.5 shrink-0" aria-label="Locked" />
                </div>
              ) : (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  clsx(
                    'focus-ring flex items-start gap-3 rounded-(--radius-control) px-3 py-2.5 transition-colors',
                    isActive ? 'bg-[var(--frost)] text-ink shadow-sm' : 'text-ink-2 hover:bg-[var(--field-bg)]',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className="mt-0.5 size-[18px] shrink-0" aria-hidden />
                    <span className="min-w-0 leading-tight">
                      <span className={clsx('block text-[14px]', isActive && 'font-medium')}>{label}</span>
                      {badge && <span className={clsx('mt-0.5 block truncate text-[12px]', TONE_TEXT[badge.tone])}>{badge.text}</span>}
                    </span>
                  </>
                )}
              </NavLink>
              ),
            )}
          </nav>

          <div className="mt-auto flex items-center gap-3 rounded-(--radius-panel) p-2">
            <Avatar name={user?.name ?? 'V'} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[14px] font-medium">{user?.name}</div>
              <div className="truncate text-[12px] text-ink-3">{user?.email}</div>
            </div>
            <Button variant="ghost" size="sm" className="!px-2" onClick={signOut} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 pb-28 lg:pb-0">
          <div className="glass mb-4 flex items-center gap-2 rounded-full py-2 pr-2 pl-4 lg:hidden">
            <Logo className="size-6 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{v?.profile.legalName || 'Vendor portal'}</span>
            <Button variant="ghost" size="sm" className="!px-2" onClick={signOut} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
          <Outlet />
        </main>
      </div>

      <nav
        aria-label="Vendor portal"
        className="glass-strong fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-full p-1.5 pb-[max(6px,env(safe-area-inset-bottom))] lg:hidden"
      >
        {nav.map(({ to, short, icon: Icon, badge, locked }) =>
          locked ? (
            <div key={to} aria-disabled="true" className="relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[11px] text-ink-3 opacity-60">
              <Icon className="size-5" aria-hidden />
              {short}
              <Lock className="absolute top-0.5 right-[26%] size-3" aria-label="Locked" />
            </div>
          ) : (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx('relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[11px]', isActive ? 'bg-[var(--frost)] text-accent' : 'text-ink-2')
            }
          >
            <Icon className="size-5" aria-hidden />
            {short}
            {badge && (badge.tone === 'warning' || badge.tone === 'danger') && (
              <span className="absolute top-0.5 right-[26%] size-2 rounded-full bg-bad" aria-label={badge.text} />
            )}
          </NavLink>
          ),
        )}
      </nav>
    </div>
  );
}
