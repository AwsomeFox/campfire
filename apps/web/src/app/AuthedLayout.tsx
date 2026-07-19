/**
 * Guards the authed subtree: redirects to /login if ready && !me, shows a
 * centered splash while the first /me fetch is in flight, and wraps children
 * in CampaignProvider so campaign-scoped nav/pages can resolve names.
 */
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import { CampaignProvider } from './CampaignContext';
import { useAuthStatus } from './AuthStatusGate';

function Splash() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="text-5xl animate-pulse">🔥</span>
    </div>
  );
}

export function AuthedLayout() {
  const { me, ready } = useAuth();
  const { status, loading: statusLoading } = useAuthStatus();

  if (!ready || statusLoading) {
    return <Splash />;
  }

  if (status?.setupRequired) {
    return <Navigate to="/setup" replace />;
  }

  if (!me) {
    return <Navigate to="/login" replace />;
  }

  return (
    <CampaignProvider>
      <Outlet />
    </CampaignProvider>
  );
}
