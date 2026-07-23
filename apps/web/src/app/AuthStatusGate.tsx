/**
 * Fetches GET /auth/status once and exposes it via context. The authed layout
 * uses this to redirect to /setup on first run (setupRequired). SetupPage and
 * LoginPage also read it to bounce to the other screen when appropriate.
 *
 * Models loading / success / error (issue #801) so a failed status fetch is
 * never mistaken for "configured, show Sign in" — Retry re-runs this alongside
 * /me through the shared bootstrap recovery surface.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthStatus } from '@campfire/schema';
import { api, API } from '../lib/api';
import { authStatusPhase, type AuthStatusPhase } from './authBootstrapState';

interface AuthStatusValue {
  status: AuthStatus | null;
  loading: boolean;
  /** True when the latest /auth/status attempt failed (network / non-2xx). */
  error: boolean;
  /** Derived loading | success | error phase for bootstrap gates. */
  phase: AuthStatusPhase;
  /** Re-fetch status. Resolves true on success, false on failure (does not throw). */
  refresh(): Promise<boolean>;
}

const AuthStatusContext = createContext<AuthStatusValue>({
  status: null,
  loading: true,
  error: false,
  phase: 'loading',
  refresh: async () => false,
});

export function AuthStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(false);
    try {
      const next = await api.get<AuthStatus>(`${API}/auth/status`);
      setStatus(next);
      setError(false);
      return true;
    } catch {
      // Leave any prior status in place so a transient blip during an already
      // configured session does not erase setupRequired; phase still reports
      // error so unsigned bootstrap can recover (#801). Callers that must not
      // keep a stale answer (post-setup exit) check the boolean return.
      setError(true);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const phase = authStatusPhase({ loading, status, error });
  const value = useMemo(
    () => ({ status, loading, error, phase, refresh }),
    [status, loading, error, phase, refresh],
  );

  return (
    <AuthStatusContext.Provider value={value}>
      {children}
    </AuthStatusContext.Provider>
  );
}

export function useAuthStatus() {
  return useContext(AuthStatusContext);
}
