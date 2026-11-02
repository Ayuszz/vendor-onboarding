import { ROLE_LABELS } from '@vo/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Inbox, LayoutGrid, LogOut, Plus } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Button } from './ui';

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 });
  if (!user) return null;
  const canCreate = user.roles.some((r) => r === 'REQUESTER' || r === 'ADMIN');
  const isRequester = user.roles.length === 1 && user.roles[0] === 'REQUESTER';

  const nav = [
    { to: '/', label: 'Overview', short: 'Overview', icon: LayoutGrid, end: true },
    { to: '/queue', label: isRequester ? 'Needs my input' : 'My queue', short: 'Queue', icon: Inbox, count: stats.data?.myQueue },
    { to: '/vendors', label: 'All vendors', short: 'Vendors', icon: Building2 },
  ];

  return (
    <div className="min-h-dvh">
      <div className="scene" aria-hidden>
        <i />
      </div>

      <div className="mx-auto flex max-w-[1440px] gap-5 p-3 sm:p-5">
        {/* Sidebar (desktop) */}
        <aside className="glass sticky top-5 hidden h-[calc(100dvh-40px)] w-[248px] shrink-0 flex-col rounded-(--radius-window) p-4 lg:flex">
          <div className="flex items-center gap-2.5 px-2 pt-1 pb-6">
            <img src="/favicon.svg" alt="" className="size-8" />
            <div className="leading-tight">
              <div className="text-[15px] font-semibold">Vendor Onboarding</div>
              <div className="text-[12px] text-ink-3">Procurement</div>
            </div>
          </div>

          {canCreate && (
            <Button variant="primary" className="mb-5 w-full" icon={<Plus className="size-4" />} onClick={() => navigate('/vendors/new')}>
              New vendor
            </Button>
          )}

          <nav className="flex flex-col gap-0.5" aria-label="Main">
            {nav.map(({ to, label, icon: Icon, count, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  clsx(
                    'focus-ring flex items-center gap-3 rounded-(--radius-control) px-3 py-2 text-[14px] transition-colors',
                    isActive ? 'bg-[var(--frost)] font-medium text-ink shadow-sm' : 'text-ink-2 hover:bg-[var(--field-bg)]',
                  )
                }
              >
                <Icon className="size-[18px]" aria-hidden />
                <span className="flex-1">{label}</span>
                {!!count && (
                  <span className="tabular rounded-full bg-accent px-2 py-px text-[11px] font-semibold text-white">{count}</span>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto flex items-center gap-3 rounded-(--radius-panel) p-2">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[14px] font-medium">{user.name}</div>
              <div className="truncate text-[12px] text-ink-3">{user.roles.map((r) => ROLE_LABELS[r]).join(', ')}</div>
            </div>
            <Button variant="ghost" size="sm" className="!px-2" onClick={logout} aria-label="Switch user">
              <LogOut className="size-4" />
            </Button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 pb-24 lg:pb-0">
          {/* Top bar (mobile) */}
          <div className="glass mb-4 flex items-center justify-between rounded-full py-2 pr-2 pl-4 lg:hidden">
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <img src="/favicon.svg" alt="" className="size-6" /> Vendors
            </div>
            <button onClick={logout} className="focus-ring rounded-full" aria-label="Switch user">
              <Avatar name={user.name} />
            </button>
          </div>
          <Outlet />
        </main>
      </div>

      {/* Tab bar (mobile) */}
      <nav
        aria-label="Main"
        className="glass-strong fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-full p-1.5 pb-[max(6px,env(safe-area-inset-bottom))] lg:hidden"
      >
        {nav.map(({ to, short, icon: Icon, count, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              clsx(
                'relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[11px]',
                isActive ? 'bg-[var(--frost)] text-accent' : 'text-ink-2',
              )
            }
          >
            <Icon className="size-5" aria-hidden />
            {short}
            {!!count && <span className="absolute top-0.5 right-[28%] size-2 rounded-full bg-bad" aria-label={`${count} pending`} />}
          </NavLink>
        ))}
        {canCreate && (
          <NavLink to="/vendors/new" className="flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[11px] text-accent">
            <Plus className="size-5" aria-hidden />
            New
          </NavLink>
        )}
      </nav>
    </div>
  );
}
