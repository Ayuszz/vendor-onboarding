import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { VendorLayout } from './components/VendorLayout';
import { Skeleton, ToastProvider } from './components/ui';
import { ApiError, IS_DEMO } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import Login from './pages/Login';
import './styles.css';

const Overview = lazy(() => import('./pages/Overview'));
const Vendors = lazy(() => import('./pages/Vendors'));
const VendorEditor = lazy(() => import('./pages/VendorEditor'));
const VendorDetail = lazy(() => import('./pages/VendorDetail'));

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

/** Vendors land on their application, or straight into registration if they have none. */
function VendorHome() {
  const { vendorId } = useAuth();
  return <Navigate to={vendorId ? `/vendors/${vendorId}` : '/vendors/new'} replace />;
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
            <Route path="vendors/new" element={<VendorEditor />} />
            <Route path="vendors/:id" element={<VendorDetail />} />
            <Route path="vendors/:id/edit" element={<VendorEditor />} />
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
