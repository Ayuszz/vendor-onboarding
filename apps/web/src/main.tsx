import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { VendorLayout } from './components/VendorLayout';
import { Skeleton, ToastProvider } from './components/ui';
import { ApiError, IS_DEMO, api } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { applyTheme } from './lib/theme';
import Login from './pages/Login';
import './styles.css';

// Apply the saved theme before the first paint so there is no flash.
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

const Overview = lazy(() => import('./pages/Overview'));
const Vendors = lazy(() => import('./pages/Vendors'));
const VendorEditor = lazy(() => import('./pages/VendorEditor'));
const VendorDetail = lazy(() => import('./pages/VendorDetail'));
const VendorDocuments = lazy(() => import('./pages/VendorDocuments'));
const VendorSettings = lazy(() => import('./pages/VendorSettings'));

const Router = IS_DEMO ? MemoryRouter : BrowserRouter;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/** Vendors land on their approval status, or straight into registration if they are new. */
function VendorHome() {
  const { vendorId } = useAuth();
  const vendor = useQuery({ queryKey: ['vendor', vendorId], queryFn: () => api.get(vendorId!), enabled: !!vendorId });
  if (vendorId && vendor.isPending) return <PageFallback />;
  // Initiated vendors (registered, not yet submitted) only have the Application open.
  return <Navigate to={vendor.data && vendor.data.state !== 'DRAFT' ? '/status' : '/application'} replace />;
}

/** Every vendor section except the Application stays locked until the application is submitted. */
function Unlocked({ children }: { children: ReactElement }) {
  const { vendorId } = useAuth();
  const vendor = useQuery({ queryKey: ['vendor', vendorId], queryFn: () => api.get(vendorId!), enabled: !!vendorId });
  if (!vendorId) return <Navigate to="/application" replace />;
  if (vendor.isPending) return <PageFallback />;
  if (!vendor.data || vendor.data.state === 'DRAFT') return <Navigate to="/application" replace />;
  return children;
}

function VendorStatus() {
  const { vendorId } = useAuth();
  return <VendorDetail vendorId={vendorId!} />;
}

function Gate() {
  const { user, loading, isVendor } = useAuth();
  if (loading) return <div className="scene" aria-hidden><i /></div>;
  if (!user) return <Login />;
  if (isVendor)
    return (
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<VendorLayout />}>
            <Route index element={<VendorHome />} />
            <Route path="application" element={<VendorEditor />} />
            <Route path="status" element={<Unlocked><VendorStatus /></Unlocked>} />
            <Route path="documents" element={<Unlocked><VendorDocuments /></Unlocked>} />
            <Route path="settings" element={<Unlocked><VendorSettings /></Unlocked>} />
            <Route path="*" element={<VendorHome />} />
          </Route>
        </Routes>
      </Suspense>
    );
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="queue" element={<Vendors mode="queue" />} />
          <Route path="vendors" element={<Vendors mode="all" />} />
          <Route path="vendors/new" element={<VendorEditor />} />
          <Route path="vendors/:id" element={<VendorDetail />} />
          <Route path="vendors/:id/edit" element={<VendorEditor />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router>
        <ToastProvider>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </ToastProvider>
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
