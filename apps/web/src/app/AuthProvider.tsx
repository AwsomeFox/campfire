/**
 * Implements the AuthState contract declared in ./auth.tsx.
 * On mount: GET /me. 401 -> me:null. Exposes ready/isAdmin/roleIn/refresh/logout.
 *
 * #579 — STALE VS LOGGED OUT: `/me` is excluded from the SW runtime cache (see
 * vite.config.ts), so a successful `/me` is PROVEN-LIVE — it cannot have been
 * served from cache. AuthProvider therefore decides what to do from the FETCH
 * OUTCOME alone, never `navigator.onLine`:
 *
 *   - /me ok            -> live identity. If it differs from the prior session,
 *                          that's a proven identity change (sign-in / account
 *                          switch) -> wipe caches, persist the new snapshot.
 *   - /me 401           -> proven logged out -> clear caches + persisted snapshot.
 *   - /me network error -> could not reach the server. NOT logged out. Restore the
 *                          persisted last-known identity (if any) flagged
 *                          `staleIdentity`, leave the SW cache intact so the
 *                          authed UI can keep rendering cached campaign data.
 *
 * This is what makes "router up but Campfire down" safe: the cached `/me` is no
 * longer in play (it's not cached), so it can never be mistaken for a live one,
 * and an offline reload no longer wipes the very cache it depends on.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Me, Role, ServerInstance } from '@campfire/schema';
import { api, ApiError, API } from '../lib/api';
import { queryClient } from '../lib/query';
import {
  clearApiCache,
  clearMeSnapshot,
  persistMeSnapshot,
  readMeSnapshot,
  subscribeToCachePurges,
} from '../lib/swCache';
import { AuthContext, type AuthState } from './auth';
import {
  clearAuthStorage,
  setAuthStorage,
  useAuthStorageListener,
} from '../features/auth/useAuthStorageListener';
import { applyReadingPreference } from './readingPreferences';
import { clearLiveAnnouncements } from '../components/Announcer';
// Re-exported here so feature code that imports from './AuthProvider' (and the
// e2e specs) can keep doing so; the logic itself lives in authDecision.ts so it
// can be unit-tested without JSX and without React.
export {
  decideAuthOutcome,
  type AuthDecision,
  type AuthDecisionInputs,
  type MeFetchOutcome,
} from './authDecision';
import { decideAuthOutcome, type MeFetchOutcome } from './authDecision';
import {
  isMembershipSyncMessage,
  openMembershipSyncChannel,
} from '../lib/membershipLiveSync';

/**
 * Blends a #rrggbb hex color toward white by `ratio` (0-1). Used to derive a
 * lighter "-2"/hover tint from the user's chosen accent, mirroring the static
 * --color-accent-2 relationship baked into index.css for the default palette.
 */
function mixWithWhite(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const blend = (c: number) => Math.round(c + (255 - c) * ratio);
  return `#${[blend(r), blend(g), blend(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Applies (or clears, when null) the user's personal accent color override as CSS custom properties. */
function applyAccentColor(accentColor: string | null): void {
  const root = document.documentElement.style;
  if (accentColor) {
    const accent2 = mixWithWhite(accentColor, 0.3);
    root.setProperty('--color-accent', accentColor);
    root.setProperty('--cf-accent', accentColor);
    root.setProperty('--color-accent-2', accent2);
    root.setProperty('--cf-accent-2', accent2);
  } else {
    root.removeProperty('--color-accent');
    root.removeProperty('--cf-accent');
    root.removeProperty('--color-accent-2');
    root.removeProperty('--cf-accent-2');
  }
}

/** Translates a thrown /me error into a MeFetchOutcome. */
function outcomeFromError(err: unknown): MeFetchOutcome {
  if (err instanceof ApiError && err.status === 401) return { kind: 'loggedOut' };
  // Any other ApiError (5xx etc) or a network failure means we couldn't get a
  // proven-live identity — treat as unreachable, never as logged out.
  return { kind: 'unreachable' };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [staleIdentity, setStaleIdentity] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // Last authenticated user id we've seen this page-session. Lets us detect a
  // proven-live change of identity (first sign-in or an account switch) so we can
  // drop any cached campaign data belonging to a prior session before it renders.
  const lastUserIdRef = useRef<number | null>(null);
  // #723: last data-generation identity confirmed live THIS page-session. Lets us
  // detect a restore mid-session (no reload): a polling /me that now reports a
  // different generation than the one this tab already saw wipes the cache even
  // though the user id is unchanged. Only a PROVEN-LIVE /me updates this (never a
  // stale/restored identity), so it can't itself be poisoned by offline artifacts.
  const lastInstanceRef = useRef<ServerInstance | null>(null);
  // Issue #506 / Bugbot: bumped synchronously at the start of logout() so any
  // in-flight refresh() that resolves after sign-out discards its result instead
  // of resurrecting `me` from a cookie that hasn't been revoked yet.
  const logoutEpochRef = useRef(0);

  const handleMultiTabSignOut = useCallback(() => {
    logoutEpochRef.current += 1;
    setMe(null);
    lastUserIdRef.current = null;
    lastInstanceRef.current = null;
    applyAccentColor(null);
    applyReadingPreference(document.documentElement, 'default');
    clearAuthStorage();
    clearMeSnapshot();
    setStaleIdentity(false);
    setLastSyncedAt(null);
    setConnectionError(false);
    // Issue #506: peer tabs must not keep assertive/polite combat/HP text after
    // another tab signs out (AnnounceProvider sits below us, so use the module
    // entrypoint rather than the React hook).
    clearLiveAnnouncements();
    // Drop in-memory campaign data immediately; SW cache purge stays best-effort.
    queryClient.clear();
    // If the first /me was still in flight, refresh() will early-return — mark
    // ready so AuthedLayout can leave the splash and show the logged-out UI.
    setReady(true);
    void clearApiCache();
  }, []);

  useAuthStorageListener(handleMultiTabSignOut);

  const refresh = useCallback(async () => {
    const epoch = logoutEpochRef.current;
    let outcome: MeFetchOutcome;
    try {
      const nextMe = await api.get<Me>(`${API}/me`);
      outcome = { kind: 'live', me: nextMe };
    } catch (err) {
      outcome = outcomeFromError(err);
    }

    // Sign-out won the race: do not apply a late /me (live or snapshot restore).
    // Still mark ready — otherwise a first-load /me cancelled by multi-tab
    // sign-out leaves AuthedLayout stuck on Splash forever.
    if (epoch !== logoutEpochRef.current) {
      setReady(true);
      return;
    }

    const snapshot = readMeSnapshot<Me>();
    const decision = decideAuthOutcome(outcome, {
      currentUserId: lastUserIdRef.current,
      currentInstance: lastInstanceRef.current,
      snapshot,
    });

    if (decision.shouldWipeCaches) {
      await clearApiCache();
      queryClient.clear();
    }
    // Re-check after the cache await — logout may have started meanwhile.
    if (epoch !== logoutEpochRef.current) {
      setReady(true);
      return;
    }

    if (decision.shouldClearSnapshot) {
      clearMeSnapshot();
    }
    if (decision.snapshotToPersist) {
      persistMeSnapshot(
        decision.snapshotToPersist.me,
        decision.snapshotToPersist.confirmedAt,
        decision.snapshotToPersist.instance,
      );
    }
    if (outcome.kind === 'live') {
      // Record the proven-live id so a later account switch on this same tab is
      // detected as a change. Stale/restored identities never update this — only
      // a confirmed live identity counts toward the "has the session changed?" test.
      lastUserIdRef.current = decision.me?.user.id ?? lastUserIdRef.current;
      // #723: record the proven-live data-generation identity for the same reason
      // — a later /me reporting a different generation (a restore happened) wipes
      // the cache on this tab even without a reload.
      lastInstanceRef.current = decision.me?.instance ?? lastInstanceRef.current;
    } else if (outcome.kind === 'loggedOut') {
      lastUserIdRef.current = null;
      lastInstanceRef.current = null;
    }

    setMe(decision.me);
    setConnectionError(decision.connectionError);
    setStaleIdentity(decision.staleIdentity);
    setLastSyncedAt(decision.lastSyncedAt);

    if (decision.me) {
      applyAccentColor(decision.me.user.accentColor);
      applyReadingPreference(document.documentElement, decision.me.user.textSize);
      if (outcome.kind === 'live') setAuthStorage(decision.me.user);
    } else {
      applyAccentColor(null);
      applyReadingPreference(document.documentElement, 'default');
      if (outcome.kind === 'loggedOut') clearAuthStorage();
    }

    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Issue #437: when another tab of this origin learns about a role change for
  // this user (via campaign SSE), it posts on the membership sync channel so
  // tabs without that campaign's stream (home, /screen, /admin) still refresh
  // /me. Listening here — above Layout — covers every authenticated surface.
  useEffect(() => {
    if (!me?.user.id) return;
    const channel = openMembershipSyncChannel(me.user.id);
    if (!channel) return;
    const onMessage = (event: MessageEvent) => {
      if (!isMembershipSyncMessage(event.data)) return;
      void refresh();
    };
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, [me?.user.id, refresh]);

  // #723 cross-tab purge: when ANOTHER tab of this origin clears the SW cache
  // (account switch, restore, logout — anything that calls clearApiCache), it
  // broadcasts on 'cf.cache-purge'. The SW Cache Storage deletion is already
  // origin-wide, but THIS tab's React Query cache is in-memory and per-tab;
  // without this listener we'd keep rendering the now-stale data until our own
  // next /me detects the change. Clearing the query cache forces the next read
  // to revalidate against the network. We do NOT touch lastInstanceRef here:
  // a peer's wipe doesn't tell us the NEW generation, so the next live /me is
  // still the authority that re-validates it (and may wipe again if needed).
  useEffect(() => {
    const unsubscribe = subscribeToCachePurges(() => {
      queryClient.clear();
    });
    return unsubscribe;
  }, []);

  const logout = useCallback(async () => {
    // Issue #506: invalidate the server session and clear local state without
    // awaiting either network/cache work. Callers (Layout) must be able to
    // announce + navigate synchronously; `clearApiCache` is documented as
    // never blocking logout; a stalled /auth/logout must not hold the UI.
    // Bump the epoch FIRST so any in-flight refresh() cannot re-apply `me`
    // from a cookie that still looks valid until the POST lands.
    logoutEpochRef.current += 1;

    // Fire server invalidation immediately (before/alongside the local clear)
    // so the session-survival window on reload is as short as possible. Errors
    // are swallowed — the local session is over regardless.
    void api.post(`${API}/auth/logout`).catch(() => {
      /* Swallowed intentionally — see comment above. */
    });

    // `clearAuthStorage()` also fires the storage event that drives multi-tab
    // sign-out (issue #666), so other tabs clear immediately too.
    clearAuthStorage();
    setMe(null);
    // Drop this account's cached campaign data so the next person to sign in on
    // this device never inherits it (issue #268), and clear the persisted
    // offline identity so an offline reload no longer restores this account.
    lastUserIdRef.current = null;
    lastInstanceRef.current = null;
    clearMeSnapshot();
    setStaleIdentity(false);
    setLastSyncedAt(null);
    setConnectionError(false);
    applyAccentColor(null);
    applyReadingPreference(document.documentElement, 'default');
    // Clear React Query synchronously so a fast shared-device re-login cannot
    // read the prior account's in-memory campaign cache. SW Cache Storage purge
    // stays fire-and-forget (must never block sign-out).
    queryClient.clear();
    setReady(true);
    void clearApiCache();
  }, []);

  const isAdmin = me?.user.serverRole === 'admin';

  // Campaign role comes ONLY from an actual membership — server admins get no
  // implicit dm (admin ≠ auto-DM, issue #9), matching the API's RoleResolver.
  const roleIn = useCallback(
    (campaignId: number): Role | null => {
      if (!me) return null;
      const membership = me.memberships.find((m) => m.campaignId === campaignId);
      return membership?.role ?? null;
    },
    [me],
  );

  const value = useMemo<AuthState>(
    () => ({ me, ready, connectionError, staleIdentity, lastSyncedAt, isAdmin, roleIn, refresh, logout }),
    [me, ready, connectionError, staleIdentity, lastSyncedAt, isAdmin, roleIn, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
