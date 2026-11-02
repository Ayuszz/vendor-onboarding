import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Logo } from './ui';

/** Lean shell for vendor accounts: no internal navigation, just their own application. */
export function VendorLayout() {
  const { user, vendorId, logout } = useAuth();
  const navigate = useNavigate();
  const signOut = () => {
    navigate('/', { replace: true });
    logout();
  };
  const vendor = useQuery({ queryKey: ['vendor', vendorId], queryFn: () => api.get(vendorId!), enabled: !!vendorId });
  const company = vendor.data?.profile.legalName;
  return (
    <div className="min-h-dvh">
      <div className="scene" aria-hidden>
        <i />
      </div>
      <header className="sticky top-0 z-40 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="glass mx-auto flex max-w-[960px] items-center gap-3 rounded-full py-2 pr-2 pl-4">
          <Logo className="size-7 shrink-0" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[15px] font-semibold">{company || 'Vendor portal'}</div>
            <div className="truncate text-[12px] text-ink-3">{user?.email}</div>
          </div>
          <Button variant="ghost" size="sm" icon={<LogOut className="size-4" />} onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-[960px] px-4 pt-5 pb-28 sm:px-5">
        <Outlet />
      </main>
    </div>
  );
}
