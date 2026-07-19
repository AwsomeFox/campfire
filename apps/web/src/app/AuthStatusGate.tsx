/**
 * Fetches GET /auth/status once and exposes it via context. The authed layout
 * uses this to redirect to /setup on first run (setupRequired). SetupPage and
 * LoginPage also read it to bounce to the other screen when appropriate.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthStatus } from '@campfire/schema';
import { api, API } from '../lib/api';

interface AuthStatusValue {
  status: AuthStatus | null;
  loading: boolean;
  refresh(): Promise<void>;
}

const AuthStatusContext = createContext<AuthStatusValue>({
  status: null,
  loading: true,
  refresh: async () => {},
});

export function AuthStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await api.get<AuthStatus>(`${API}/auth/status`);
      setStatus(next);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <AuthStatusContext.Provider value={{ status, loading, refresh }}>
      {children}
    </AuthStatusContext.Provider>
  );
}

export function useAuthStatus() {
  return useContext(AuthStatusContext);
}
