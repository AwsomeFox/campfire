/**
 * Guards the authed subtree: redirects to /login if ready && !me, shows a
 * centered splash while the first /me fetch is in flight, and wraps children
 * in CampaignProvider so campaign-scoped nav/pages can resolve names.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { CampaignProvider } from './CampaignContext';
import { useAuthStatus } from './AuthStatusGate';
import { GameIcon } from '../components/GameIcon';
import { useClearAnnouncementsOnScope } from '../components/useClearAnnouncementsOnScope';

function Splash() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="flex justify-center animate-pulse text-[var(--color-accent)]"><GameIcon slug="campfire" size={52} /></span>
    </div>
  );
}

function ConnectionErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card elev-sm text-center space-y-2" style={{ maxWidth: 380 }}>
        <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="campfire" size={28} /></p>
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
  const location = useLocation();

  // Issue #434: wipe app-root live-region text on identity change and when this
  // authed tree unmounts (sign-out → /login, including cast-to-TV routes that
  // sit outside Layout). Campaign switches are handled in Layout.
  useClearAnnouncementsOnScope(me?.user.id ?? null);

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
    // Carry the deep link we bounced from so LoginPage can return to it after
    // sign-in (issue #148). Without this a shared `/c/1/quests/5` link lands on
    // the campaign list. `from` is a same-origin Location, validated on read.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <CampaignProvider>
      <Outlet />
    </CampaignProvider>
  );
}
