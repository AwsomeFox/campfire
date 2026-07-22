/**
 * Auth context — OWNED BY THE FOUNDATION FEATURE (auth screens agent implements the provider).
 * The exported interface below is the CONTRACT: feature screens rely on it; do not change shapes.
 */
import { createContext, useContext } from 'react';
import type { Me, Role } from '@campfire/schema';

export interface AuthState {
  me: Me | null; // null = not logged in (or still loading — check ready)
  ready: boolean; // false until the first /me fetch settles
  /**
   * True when the first /me fetch settled with a network/server error rather than a
   * clean 401. Lets AuthedLayout distinguish "not logged in" from "can't reach the
   * server" instead of spinning on the splash screen forever.
   */
  connectionError: boolean;
  /**
   * True when `me` was restored from the persisted last-known snapshot rather than
   * confirmed live on this load (issue #579). Happens when `/me` could not reach
   * the server (offline, or origin reachable but Campfire down). AuthProvider never
   * infers this from `navigator.onLine` — only a real `/me` failure sets it. The
   * UI should show an "offline — showing last-known" banner and avoid mutations,
   * since cached campaign data may be stale.
   */
  staleIdentity: boolean;
  /**
   * Wall-clock ms (Date.now()) at which `me` was last confirmed live by a real
   * `/me` round-trip. Null while loading or when never confirmed (e.g. logged out).
   * Used to label the offline banner "last synced …". When `staleIdentity` is true
   * this is the time the snapshot was persisted, NOT the current render time.
   */
  lastSyncedAt: number | null;
  isAdmin: boolean;
  /** Effective role in a campaign: admin → dm; else membership role; null = no access. */
  roleIn(campaignId: number): Role | null;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  me: null,
  ready: false,
  connectionError: false,
  staleIdentity: false,
  lastSyncedAt: null,
  isAdmin: false,
  roleIn: () => null,
  refresh: async () => {},
  logout: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
