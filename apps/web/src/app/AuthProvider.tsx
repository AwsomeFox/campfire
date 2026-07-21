/**
 * Implements the AuthState contract declared in ./auth.tsx.
 * On mount: GET /me. 401 -> me:null. Exposes ready/isAdmin/roleIn/refresh/logout.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Me, Role, TextSize } from '@campfire/schema';
import { api, ApiError, API } from '../lib/api';
import { queryClient } from '../lib/query';
import { clearApiCache } from '../lib/swCache';
import { AuthContext, type AuthState } from './auth';

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  // Last authenticated user id we've seen this page-session. Lets us detect a
  // change of identity (first sign-in or an account switch) so we can drop any
  // cached campaign data belonging to a prior session before it renders.
  const lastUserIdRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextMe = await api.get<Me>(`${API}/me`);
      if (navigator.onLine && lastUserIdRef.current !== nextMe.user.id) {
        // Auth identity resolved to a (new) user while online: a fresh sign-in or
        // an account switch. Purge the SW's global /api cache and the in-memory
        // Query cache so a previous session's — or a pre-seed — HP, members and
        // quests can never render as truth for this user (issue #268); the reads
        // that follow simply refill from the live API.
        //
        // The `navigator.onLine` guard matters because /me is itself an /api GET
        // and can therefore resolve from the SW cache when offline. Without it, an
        // OFFLINE reload of a returning session would trip this branch and wipe the
        // very offline-fallback cache the SW exists to preserve. When offline we
        // leave the cache untouched and keep showing last-known state.
        lastUserIdRef.current = nextMe.user.id;
        await clearApiCache();
        queryClient.clear();
      }
      setMe(nextMe);
      setConnectionError(false);
      applyAccentColor(nextMe.user.accentColor);
      applyTextSize(nextMe.user.textSize);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
        setConnectionError(false);
        applyAccentColor(null);
        applyTextSize('default');
      } else {
        // Network error or non-401 server failure (API down, 5xx, etc). Don't treat
        // this as "not logged in" — that would bounce a real session to /login. Surface
        // it as a connection error instead so AuthedLayout can offer a retry.
        setConnectionError(true);
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(async () => {
    await api.post(`${API}/auth/logout`);
    setMe(null);
    // Drop this account's cached campaign data so the next person to sign in on
    // this device never inherits it (issue #268).
    lastUserIdRef.current = null;
    await clearApiCache();
    queryClient.clear();
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
    () => ({ me, ready, connectionError, isAdmin, roleIn, refresh, logout }),
    [me, ready, connectionError, isAdmin, roleIn, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
