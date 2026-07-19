/**
 * Implements the AuthState contract declared in ./auth.tsx.
 * On mount: GET /me. 401 -> me:null. Exposes ready/isAdmin/roleIn/refresh/logout.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me, Role } from '@campfire/schema';
import { api, ApiError, API } from '../lib/api';
import { AuthContext, type AuthState } from './auth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const nextMe = await api.get<Me>(`${API}/me`);
      setMe(nextMe);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
      } else {
        throw err;
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
  }, []);

  const isAdmin = me?.user.serverRole === 'admin';

  const roleIn = useCallback(
    (campaignId: number): Role | null => {
      if (!me) return null;
      if (isAdmin) return 'dm';
      const membership = me.memberships.find((m) => m.campaignId === campaignId);
      return membership?.role ?? null;
    },
    [me, isAdmin],
  );

  const value = useMemo<AuthState>(
    () => ({ me, ready, isAdmin, roleIn, refresh, logout }),
    [me, ready, isAdmin, roleIn, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
