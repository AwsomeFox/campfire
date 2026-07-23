/**
 * Guards the authed subtree: redirects to /login if ready && !me, shows a
 * centered splash while the first /me fetch is in flight, and wraps children
 * in CampaignProvider so campaign-scoped nav/pages can resolve names.
 *
 * Bootstrap recovery (issue #801): Retry refreshes BOTH /auth/status and /me.
 * Setup vs login is never chosen while status is unknown.
 */
import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { CampaignProvider } from './CampaignContext';
import { useAuthStatus } from './AuthStatusGate';
import { BootstrapRecoveryScreen } from './BootstrapRecoveryScreen';
import { authedBootstrapSurface, retryAuthBootstrap } from './authBootstrapState';
import { GameIcon } from '../components/GameIcon';
import { useClearAnnouncementsOnScope } from '../components/useClearAnnouncementsOnScope';
import { parseCampaignIdParam } from '../lib/parseCampaignIdParam';

function Splash() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="flex justify-center animate-pulse text-[var(--color-accent)]"><GameIcon slug="campfire" size={52} /></span>
    </div>
  );
}

export function AuthedLayout() {
  const { me, ready, connectionError, refresh, sessionExpired } = useAuth();
  const { status, phase: statusPhase, refresh: refreshStatus } = useAuthStatus();
  const location = useLocation();
  const params = useParams<{ campaignId?: string }>();
  const campaignId = parseCampaignIdParam(params.campaignId);

  // Issue #434: wipe app-root live-region text on identity/campaign change and when
  // this authed tree unmounts (sign-out → /login). Cast-to-TV `/c/:id/screen` sits
  // outside Layout, so campaign scope must clear here too.
  useClearAnnouncementsOnScope(me?.user.id ?? null, campaignId);

  const surface = authedBootstrapSurface({
    statusPhase,
    setupRequired: Boolean(status?.setupRequired),
    meReady: ready,
    hasMe: Boolean(me),
    connectionError,
  });

  if (surface === 'splash') {
    return <Splash />;
  }

  // Mid-session expiry is a proven 401 (issue #885) — don't mask it with bootstrap
  // recovery; send the operator to Sign in with an explanation.
  if (surface === 'recovery' && !sessionExpired) {
    return (
      <BootstrapRecoveryScreen
        onRetry={() => {
          void retryAuthBootstrap(refreshStatus, refresh);
        }}
      />
    );
  }

  if (surface === 'setup') {
    return <Navigate to="/setup" replace />;
  }

  if (surface === 'login' || (sessionExpired && !me)) {
    // Carry the deep link we bounced from so LoginPage can return to it after
    // sign-in (issue #148). Without this a shared `/c/1/quests/5` link lands on
    // the campaign list. `from` is a same-origin Location, validated on read.
    // Issue #885: also forward `sessionExpired` so the login screen can explain
    // the bounce without treating a cold signed-out visit the same way.
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location, ...(sessionExpired ? { sessionExpired: true } : {}) }}
      />
    );
  }

  return (
    <CampaignProvider>
      <Outlet />
    </CampaignProvider>
  );
}
