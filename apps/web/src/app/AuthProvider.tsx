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
import type { Me, Role, ServerInstance, TextSize } from '@campfire/schema';
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
  clearAuthStorage,
  setAuthStorage,
  useAuthStorageListener,
} from '../features/auth/useAuthStorageListener';

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

/**
 * Applies (or clears, for 'default') the user's text-size preference as a
 * data attribute on <html>; index.css scales the UI off it.
 */
function applyTextSize(textSize: TextSize): void {
  if (textSize === 'large') {
    document.documentElement.dataset.textSize = 'large';
  } else {
    delete document.documentElement.dataset.textSize;
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

  const handleMultiTabSignOut = useCallback(() => {
    setMe(null);
    lastUserIdRef.current = null;
    applyAccentColor(null);
    applyTextSize('default');
    clearAuthStorage();
    void clearApiCache();
    queryClient.clear();
  }, []);

  useAuthStorageListener(handleMultiTabSignOut);

  const refresh = useCallback(async () => {
    let outcome: MeFetchOutcome;
    try {
      const nextMe = await api.get<Me>(`${API}/me`);
      outcome = { kind: 'live', me: nextMe };
    } catch (err) {
      outcome = outcomeFromError(err);
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
    }

    setMe(decision.me);
    setConnectionError(decision.connectionError);
    setStaleIdentity(decision.staleIdentity);
    setLastSyncedAt(decision.lastSyncedAt);

    if (decision.me) {
      applyAccentColor(decision.me.user.accentColor);
      applyTextSize(decision.me.user.textSize);
      // #666: mirror the live identity into localStorage so a storage-event
      // listener in OTHER tabs of this origin can observe sign-in / account
      // switches. We only write on a proven-live identity — never on a stale /
      // restored snapshot — so offline restores can't themselves seed the keys.
      setAuthStorage(decision.me.user);
    } else {
      applyAccentColor(null);
      applyTextSize('default');
      // #666: when a proven logout (or no identity) is decided, drop the shared
      // auth keys. The storage event this fires propagates the sign-out to peer
      // tabs whose own /me hasn't re-run yet.
      clearAuthStorage();
    }

    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    try {
      await api.post(`${API}/auth/logout`);
    } finally {
      // #666: drop the shared auth keys first — the storage event this fires is
      // what propagates the sign-out to peer tabs (their useAuthStorageListener
      // runs their own logout path). Wrapped in finally so a failing logout POST
      // still clears the local session instead of leaving the user stuck authed.
      clearAuthStorage();
      // Drop this account's cached campaign data so the next person to sign in on
      // this device never inherits it (issue #268), and clear the persisted
      // offline identity so an offline reload no longer restores this account.
      lastUserIdRef.current = null;
      lastInstanceRef.current = null;
      await clearApiCache();
      queryClient.clear();
      clearMeSnapshot();
      setMe(null);
      setStaleIdentity(false);
      setLastSyncedAt(null);
      setConnectionError(false);
      applyAccentColor(null);
      applyTextSize('default');
    }
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

