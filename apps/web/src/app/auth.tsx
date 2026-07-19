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
  isAdmin: false,
  roleIn: () => null,
  refresh: async () => {},
  logout: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
