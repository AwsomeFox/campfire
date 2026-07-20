/**
 * Self-service signup screen — only reachable when the server-admin allowSignup
 * setting is on (GET /auth/status `signupEnabled`). Same card-on-radial-ground
 * language as LoginPage/SetupPage. Bounces to /setup on first run and to /login
 * when signup is disabled.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type { Me } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAuthStatus } from '../../app/AuthStatusGate';

function FlameMark() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3c1.8 2.6 4.6 4.2 4.6 8a4.6 4.6 0 0 1-9.2 0c0-1.5.5-2.7 1.3-3.9.3 1 .9 1.7 1.7 2.2C10.2 7 10.7 4.9 12 3z"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M5 21l14-3M19 21L5 18"
        stroke="var(--color-neutral-600)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SignupPage() {
  const { status, loading } = useAuthStatus();
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && status?.setupRequired) {
    return <Navigate to="/setup" replace />;
  }
  if (!loading && status && !status.signupEnabled) {
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
      await api.post<Me>(`${API}/auth/signup`, {
        username,
        password,
        displayName: displayName.trim() || undefined,
      });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('That username is already taken.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Signup is disabled — ask your server admin for an account.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — wait a minute and try again.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="min-h-screen grid place-items-center p-6"
      style={{
        background:
          'radial-gradient(80% 60% at 50% 0%, var(--color-neutral-900) 0%, var(--color-bg) 70%)',
      }}
    >
      <div className="flex flex-col gap-4" style={{ width: 'min(380px, 100%)' }}>
        <div className="card elev-md items-center text-center" style={{ padding: '28px 26px', gap: 14 }}>
          <FlameMark />
          <div>
            <h3 style={{ margin: 0 }}>Campfire</h3>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Pull up a seat — create your account.
            </p>
          </div>

          <form onSubmit={onSubmit} className="w-full flex flex-col gap-3">
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="displayName">
                Display name <span className="text-muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· optional</span>
              </label>
              <input
                id="displayName"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                type="password"
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>

            {error && <p className="text-sm text-rose-400">{error}</p>}

            <button type="submit" className="btn btn-primary btn-block" style={{ minHeight: 44 }} disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <Link to="/login" className="btn btn-ghost" style={{ fontSize: 12.5, marginTop: 2 }}>
            Already have an account? Sign in
          </Link>
        </div>

        <p className="text-center text-muted" style={{ fontSize: 11 }}>
          Self-hosted with ❤️ · campfire v0.1.0
        </p>
      </div>
    </div>
  );
}
