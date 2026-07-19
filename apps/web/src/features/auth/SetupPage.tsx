/**
 * First-run "light the fire" screen — creates the initial admin user.
 * Mirrors design/01-login.html aesthetic. If setup is not required, bounce
 * to /login.
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAuthStatus } from '../../app/AuthStatusGate';

export function SetupPage() {
  const { status, loading } = useAuthStatus();
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && status && !status.setupRequired) {
    return <Navigate to="/login" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!/^[a-z0-9_.-]+$/i.test(username)) {
      setError('Username may only contain letters, numbers, and _ . -');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post(`${API}/auth/setup`, {
        username,
        password,
        displayName: displayName.trim() || undefined,
      });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
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
          <p className="text-sm text-slate-400">Light the fire — set up the first admin account.</p>
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
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-slate-400 font-semibold" htmlFor="displayName">
              Display name <span className="text-slate-600 font-normal">(optional)</span>
            </label>
            <input
              id="displayName"
              className="cf-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
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
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-slate-400 font-semibold" htmlFor="confirm">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              className="cf-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          {error && <p className="text-sm text-rose-400">{error}</p>}

          <button type="submit" className="cf-btn w-full text-base" disabled={submitting}>
            {submitting ? 'Lighting…' : 'Light the fire'}
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-600">
          Self-hosted with ❤️ · <span className="text-slate-500">campfire v0.1.0</span>
        </p>
      </main>
    </div>
  );
}
