/**
 * Auth context — OWNED BY THE FOUNDATION FEATURE (auth screens agent implements the provider).
 * The exported interface below is the CONTRACT: feature screens rely on it; do not change shapes.
 */
import { createContext, useContext } from 'react';
import type { Me, Role } from '@campfire/schema';

export interface AuthState {
  me: Me | null; // null = not logged in (or still loading — check ready)
  ready: boolean; // false until the first /me fetch settles
  isAdmin: boolean;
  /** Effective role in a campaign: admin → dm; else membership role; null = no access. */
  roleIn(campaignId: number): Role | null;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  me: null,
  ready: false,
  isAdmin: false,
  roleIn: () => null,
  refresh: async () => {},
  logout: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
