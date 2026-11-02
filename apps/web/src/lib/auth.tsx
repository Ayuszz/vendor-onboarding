import type { UserDTO } from '@vo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';

interface AuthState {
  user: UserDTO | null;
  loading: boolean;
  login: (userId: string) => Promise<void>;
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

  const login = useCallback(
    async (userId: string) => {
      const { token, user } = await api.devLogin(userId);
      tokenStore.set(token);
      qc.clear();
      qc.setQueryData(['me'], user);
      setHasToken(true);
    },
    [qc],
  );

  const value = useMemo<AuthState>(
    () => ({ user: hasToken ? (me.data ?? null) : null, loading: hasToken && me.isPending, login, logout }),
    [hasToken, me.data, me.isPending, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
