import { ROLE_LABELS, type UserDTO } from '@vo/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Avatar, Skeleton, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const ROLE_HELP: Record<string, string> = {
  REQUESTER: 'Create vendors and upload documents',
  QC: 'Review quality and compliance',
  SCM: 'Review commercial and supply fit',
  FINANCE: 'Final approval and SAP creation',
  ADMIN: 'Everything, plus SAP retries',
};

/** Development sign-in. In production this screen is replaced by your SSO redirect. */
export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['dev-users'], queryFn: api.devUsers });

  const pick = async (u: UserDTO) => {
    setBusy(u.id);
    try {
      await login(u.id);
    } catch (e) {
      toast((e as Error).message, 'danger');
      setBusy(null);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="scene" aria-hidden>
        <i />
      </div>
      <div className="glass animate-rise w-full max-w-[420px] rounded-(--radius-window) p-7 sm:p-8">
        <img src="/favicon.svg" alt="" className="mb-5 size-12" />
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]">Sign in to Vendor Onboarding</h1>
        <p className="mt-2 text-[15px] text-ink-2">Pick a demo account. Each one sees the app the way that team does.</p>

        <ul className="mt-6 flex flex-col gap-1.5">
          {users.isPending &&
            Array.from({ length: 5 }, (_, i) => (
              <li key={i}>
                <Skeleton className="h-[60px]" />
              </li>
            ))}
          {users.isError && <li className="text-[14px] text-bad">Can’t reach the API. Start it with npm run dev.</li>}
          {users.data?.map((u) => (
            <li key={u.id}>
              <button
                onClick={() => pick(u)}
                disabled={!!busy}
                className="focus-ring frost flex w-full items-center gap-3 rounded-(--radius-panel) p-3 text-left transition duration-200 ease-(--ease-spring) hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60"
              >
                <Avatar name={u.name} className="size-9" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium">
                    {u.name} <span className="font-normal text-ink-3">· {u.roles.map((r) => ROLE_LABELS[r]).join(', ')}</span>
                  </span>
                  <span className="block truncate text-[13px] text-ink-2">{ROLE_HELP[u.roles[0]!]}</span>
                </span>
                {busy === u.id && <span className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
