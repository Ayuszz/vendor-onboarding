import { CATEGORY_LABELS, CONSTITUTION_LABELS } from '@vo/shared';
import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { Button, Panel, PanelHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hairline flex flex-col gap-1 border-b py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="text-[14px] text-ink-2">{label}</dt>
      <dd className="text-[15px] sm:text-right">{children}</dd>
    </div>
  );
}

export default function VendorSettings() {
  const { user, vendorId, logout } = useAuth();
  const navigate = useNavigate();
  const vendor = useQuery({ queryKey: ['vendor', vendorId], queryFn: () => api.get(vendorId!), enabled: !!vendorId });
  const p = vendor.data?.profile;

  return (
    <div className="mx-auto max-w-[760px] space-y-5">
      <h1 className="px-1 pt-2 text-[32px] leading-tight font-semibold tracking-[-0.025em]">Settings</h1>

      <Panel>
        <PanelHeader title="Account" />
        <dl className="px-5 pb-3 sm:px-6">
          <Row label="Email">{user?.email}</Row>
          <Row label="Sign-in method">One-time code sent to your email</Row>
          <Row label="Updates">We email you when your application moves to the next stage</Row>
        </dl>
      </Panel>

      <Panel>
        <PanelHeader
          title="Company"
          action={
            vendor.data && (vendor.data.state === 'DRAFT' || vendor.data.state === 'SENT_BACK') ? (
              <Button size="sm" onClick={() => navigate('/application')}>
                Edit details
              </Button>
            ) : undefined
          }
        />
        <dl className="px-5 pb-3 sm:px-6">
          <Row label="Legal name">{p?.legalName || '—'}</Row>
          <Row label="Application reference">
            <span className="tabular">{vendor.data?.reference ?? 'Not started'}</span>
          </Row>
          <Row label="Constitution">{p?.constitution ? CONSTITUTION_LABELS[p.constitution] : '—'}</Row>
          <Row label="Supplies">{p?.category ? CATEGORY_LABELS[p.category] : '—'}</Row>
          {vendor.data?.sap?.status === 'SYNCED' && (
            <Row label="Vendor code">
              <span className="tabular font-medium">{vendor.data.sap.cardCode}</span>
            </Row>
          )}
        </dl>
      </Panel>

      <Panel>
        <PanelHeader title="Appearance" description="Choose light or dark, or match your device." />
        <div className="px-5 pb-5 sm:px-6">
          <ThemeToggle className="w-full max-w-sm" />
        </div>
      </Panel>

      <Button
        variant="danger"
        icon={<LogOut className="size-4" />}
        onClick={() => {
          navigate('/', { replace: true });
          logout();
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
