import type { SessionDTO, UserDTO } from '@vo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';

interface AuthState {
  user: UserDTO | null;
  /** Vendor accounts only: their application, or null if they haven't started one. */
  vendorId: string | null;
  isVendor: boolean;
  loading: boolean;
  /** Stores the token from a successful sign-in. */
  signIn: (s: SessionDTO) => void;
  /** Re-reads the session (e.g. after a vendor creates their application). */
  refresh: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [hasToken, setHasToken] = useState(() => !!tokenStore.get());
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: hasToken, retry: false, staleTime: Infinity });

  const logout = useCallback(() => {
    tokenStore.set(null);
    setHasToken(false);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    window.addEventListener('vo:logout', logout);
    return () => window.removeEventListener('vo:logout', logout);
  }, [logout]);

  useEffect(() => {
    if (me.isError) logout();
  }, [me.isError, logout]);

  const signIn = useCallback(
    (s: SessionDTO) => {
      if (!s.token) return;
      tokenStore.set(s.token);
      qc.clear();
      qc.setQueryData(['me'], { user: s.user, vendorId: s.vendorId });
      setHasToken(true);
    },
    [qc],
  );

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const user = hasToken ? (me.data?.user ?? null) : null;
    return {
      user,
      vendorId: me.data?.vendorId ?? null,
      isVendor: !!user?.roles.includes('VENDOR'),
      loading: hasToken && me.isPending,
      signIn,
      refresh,
      logout,
    };
  }, [hasToken, me.data, me.isPending, signIn, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
