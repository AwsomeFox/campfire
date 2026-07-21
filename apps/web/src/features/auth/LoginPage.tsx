/**
 * Sign-in screen. Mirrors design/claude-design/Campfire.dc.html's "Login"
 * screen: flame mark card on a radial-gradient ground, SSO-first when OIDC
 * is configured (design shows Authentik-first), local username/password
 * form always available — primary when OIDC is off, secondary/collapsible
 * when it's on.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
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

function LocalLoginForm({
  submitting,
  onSubmit,
  username,
  setUsername,
  password,
  setPassword,
  error,
  primary,
}: {
  submitting: boolean;
  onSubmit: (e: FormEvent) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  primary: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="field">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus={primary}
          required
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
          autoComplete="current-password"
          required
        />
      </div>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <button type="submit" className={`btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-block`} style={{ minHeight: 44 }} disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>

      <p className="text-center" style={{ margin: 0, fontSize: 12 }}>
        <Link to="/reset-password" className="text-muted">
          Forgot password?
        </Link>
      </p>
    </form>
  );
}

/**
 * Open-redirect guard: only honor same-origin, in-app absolute paths. Rejects
 * protocol-relative (`//evil.com`), backslash tricks (`/\evil.com`), and
 * anything not rooted at a single `/`. Returns null when unsafe.
 */
function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // Never bounce back into an auth screen (would loop or hide the target).
  if (/^\/(login|setup|signup|reset-password)(\/|\?|#|$)/.test(raw)) return null;
  return raw;
}

export function LoginPage() {
  const { status, loading } = useAuthStatus();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Where to land after a successful sign-in: prefer an explicit `?redirect=`
  // (survives full-page navigations), then the location AuthedLayout bounced us
  // from (SPA redirect state), else the campaign list. All validated same-origin.
  const fromState = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null)?.from;
  const fromStatePath = fromState
    ? `${fromState.pathname ?? ''}${fromState.search ?? ''}${fromState.hash ?? ''}`
    : null;
  const redirectTo =
    safeInternalPath(new URLSearchParams(location.search).get('redirect')) ??
    safeInternalPath(fromStatePath) ??
    '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showLocalForm, setShowLocalForm] = useState(false);

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
      navigate(redirectTo, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Local sign-in is disabled — ask your server admin.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Wrong username or password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts — wait a minute and try again.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const oidcEnabled = Boolean(status?.oidcEnabled);
  // Forward the intended target through SSO. The OIDC flow is a full-page server
  // round-trip (callback currently always redirects to `/`), so honoring this
  // needs matching backend support; the local form already returns to it.
  const oidcLoginHref =
    redirectTo === '/'
      ? '/api/v1/auth/oidc/login'
      : `/api/v1/auth/oidc/login?redirect=${encodeURIComponent(redirectTo)}`;
  const signupEnabled = Boolean(status?.signupEnabled);
  const installHint = typeof window !== 'undefined'
    && !window.matchMedia('(display-mode: standalone)').matches
    && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

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
              Self-hosted campaign server
            </p>
          </div>

          {oidcEnabled ? (
            <>
              <a href={oidcLoginHref} className="btn btn-primary btn-block" style={{ minHeight: 44 }}>
                Sign in with Authentik
              </a>
              <p className="text-muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
                One account for players, DM and viewers.
                <br />
                Roles come from your campaign groups.
              </p>
              {showLocalForm ? (
                <div className="w-full flex flex-col gap-3" style={{ marginTop: 6 }}>
                  <div className="hr" style={{ margin: 0 }} />
                  <LocalLoginForm
                    submitting={submitting}
                    onSubmit={onSubmit}
                    username={username}
                    setUsername={setUsername}
                    password={password}
                    setPassword={setPassword}
                    error={error}
                    primary={false}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 12.5, marginTop: 2 }}
                  onClick={() => setShowLocalForm(true)}
                >
                  Sign in with username &amp; password instead
                </button>
              )}
            </>
          ) : (
            <div className="w-full">
              <LocalLoginForm
                submitting={submitting}
                onSubmit={onSubmit}
                username={username}
                setUsername={setUsername}
                password={password}
                setPassword={setPassword}
                error={error}
                primary
              />
            </div>
          )}

          {signupEnabled && (
            <Link to="/signup" className="btn btn-ghost" style={{ fontSize: 12.5, marginTop: 2 }}>
              New here? Create an account
            </Link>
          )}
        </div>

        {installHint && (
          <div
            className="flex items-center gap-2.5 text-muted"
            style={{
              padding: '10px 14px',
              border: '1px solid var(--color-divider)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
              <path d="M12 15V4m0 0L8 8m4-4l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 14v5h14v-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>
              Installs like an app — open the browser menu and choose{' '}
              <span style={{ color: 'var(--color-text)' }}>Add to Home Screen</span>.
            </span>
          </div>
        )}

        <p className="text-center text-muted" style={{ fontSize: 11 }}>
          Self-hosted with ❤️ · campfire v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
