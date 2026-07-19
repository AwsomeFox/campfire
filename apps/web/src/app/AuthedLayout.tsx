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

function ConnectionErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card elev-sm text-center space-y-2" style={{ maxWidth: 380 }}>
        <p className="text-2xl">🔥</p>
        <p className="font-bold text-white">Can&apos;t reach the server</p>
        <p className="text-sm text-slate-400">Check your connection and try again.</p>
        <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

export function AuthedLayout() {
  const { me, ready, connectionError, refresh } = useAuth();
  const { status, loading: statusLoading } = useAuthStatus();

  if (!ready || statusLoading) {
    return <Splash />;
  }

  // A cold load with the API down would otherwise land here with me=null,
  // ready=true and bounce forever between Splash and /login on every refresh
  // attempt. Surface a retry instead of pretending the user is logged out.
  if (connectionError && !me) {
    return <ConnectionErrorScreen onRetry={() => void refresh()} />;
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
