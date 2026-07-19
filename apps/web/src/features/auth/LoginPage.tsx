/**
 * Username + password login. Per design/01-login.html aesthetic, adapted for
 * local-auth (the mockup shows SSO-only; SSO is not yet built, so this form
 * covers local sign-in with a note that SSO is coming).
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { Me } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAuthStatus } from '../../app/AuthStatusGate';

export function LoginPage() {
  const { status, loading } = useAuthStatus();
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && status?.setupRequired) {
    return <Navigate to="/setup" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post<Me>(`${API}/auth/login`, { username, password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Local sign-in is disabled — ask your server admin.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Wrong username or password.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative">
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(245,158,11,.08),transparent_55%),radial-gradient(ellipse_at_bottom,rgba(56,189,248,.05),transparent_55%)] pointer-events-none" />
      <div className="fixed inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:24px_24px] opacity-30 pointer-events-none" />

      <main className="relative w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="text-5xl">🔥</div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">Campfire</h1>
          <p className="text-sm text-slate-400">The party's shared memory.</p>
        </div>

        <form onSubmit={onSubmit} className="cf-card p-6 space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-slate-400 font-semibold" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="cf-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-slate-400 font-semibold" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="cf-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <p className="text-sm text-rose-400">{error}</p>}

          <button type="submit" className="cf-btn w-full text-base" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-[11px] text-slate-500 text-center leading-relaxed">
            One account for the whole table — SSO (Authentik, Google &amp; Discord) is coming soon.
          </p>
        </form>

        <p className="text-center text-[11px] text-slate-600">
          Self-hosted with ❤️ · <span className="text-slate-500">campfire v0.1.0</span>
        </p>
      </main>
    </div>
  );
}
