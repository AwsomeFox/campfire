/**
 * Self-service signup screen — only reachable when the server-admin allowSignup
 * setting is on (GET /auth/status `signupEnabled`). Same card-on-radial-ground
 * language as LoginPage/SetupPage. Bounces to /setup on first run and to /login
 * when signup is disabled.
 */
import { useLayoutEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type { Me } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAuthStatus } from '../../app/AuthStatusGate';
import { PasswordInput } from '../../components/PasswordInput';
import { BootstrapRecoveryScreen } from '../../app/BootstrapRecoveryScreen';
import { loginBootstrapSurface, retryAuthBootstrap } from '../../app/authBootstrapState';
import {
  AUTH_ERROR_IDS,
  AUTH_FIELD_IDS,
  AUTH_GENERIC_ERROR,
  AUTH_RATE_LIMIT_ERROR,
  AUTH_SIGNUP_DISABLED_ERROR,
  AUTH_USERNAME_TAKEN_ERROR,
  type AuthErrorState,
  describedBy,
  focusAuthError,
  validateNewAccountFields,
} from './authFormA11y';

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
  const { status, phase: statusPhase, refresh: refreshStatus } = useAuthStatus();
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<AuthErrorState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useLayoutEffect(() => {
    if (error) focusAuthError(error);
  }, [error]);

  // Reuse the login bootstrap classifier: unknown status → recovery; fresh → setup.
  const bootstrap = loginBootstrapSurface({
    statusPhase,
    setupRequired: Boolean(status?.setupRequired),
  });
  if (bootstrap === 'recovery') {
    return (
      <BootstrapRecoveryScreen
        onRetry={() => {
          void retryAuthBootstrap(refreshStatus, refresh);
        }}
      />
    );
  }
  if (bootstrap === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center p-6" aria-live="polite">
        <p className="text-muted">Checking signup options…</p>
      </div>
    );
  }
  if (bootstrap === 'setup') {
    return <Navigate to="/setup" replace />;
  }
  if (bootstrap === 'form' && status && !status.signupEnabled) {
    return <Navigate to="/login" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const clientError = validateNewAccountFields({ username, password, confirm });
    if (clientError) {
      setError(clientError);
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
        setError({
          kind: 'fields',
          fields: { username: AUTH_USERNAME_TAKEN_ERROR },
          focus: 'username',
        });
      } else if (err instanceof ApiError && err.status === 403) {
        setError({ kind: 'form', message: AUTH_SIGNUP_DISABLED_ERROR });
      } else if (err instanceof ApiError && err.status === 429) {
        setError({ kind: 'form', message: AUTH_RATE_LIMIT_ERROR });
      } else {
        setError({
          kind: 'form',
          message: err instanceof ApiError ? err.message : AUTH_GENERIC_ERROR,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const fieldErrors = error?.kind === 'fields' ? error.fields : {};
  const formError = error?.kind === 'form' ? error.message : null;

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

          <form onSubmit={onSubmit} className="w-full flex flex-col gap-3" noValidate>
            <div className="field">
              <label htmlFor={AUTH_FIELD_IDS.username}>Username</label>
              <input
                id={AUTH_FIELD_IDS.username}
                className="input"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (fieldErrors.username) setError(null);
                }}
                autoComplete="username"
                autoFocus
                required
                aria-invalid={fieldErrors.username ? true : undefined}
                aria-describedby={describedBy(fieldErrors.username && AUTH_ERROR_IDS.username)}
              />
              {fieldErrors.username && (
                <p id={AUTH_ERROR_IDS.username} role="alert" className="text-sm text-rose-400" style={{ margin: 0 }}>
                  {fieldErrors.username}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor={AUTH_FIELD_IDS.displayName}>
                Display name <span className="text-muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· optional</span>
              </label>
              <input
                id={AUTH_FIELD_IDS.displayName}
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </div>
            <div className="field">
              <label htmlFor={AUTH_FIELD_IDS.password}>Password</label>
              <PasswordInput
                id={AUTH_FIELD_IDS.password}
                className="input"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setError(null);
                }}
                autoComplete="new-password"
                required
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={describedBy(fieldErrors.password && AUTH_ERROR_IDS.password)}
              />
              {fieldErrors.password && (
                <p id={AUTH_ERROR_IDS.password} role="alert" className="text-sm text-rose-400" style={{ margin: 0 }}>
                  {fieldErrors.password}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor={AUTH_FIELD_IDS.confirm}>Confirm password</label>
              <PasswordInput
                id={AUTH_FIELD_IDS.confirm}
                className="input"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (fieldErrors.confirm) setError(null);
                }}
                autoComplete="new-password"
                revealNoun="confirm password"
                required
                aria-invalid={fieldErrors.confirm ? true : undefined}
                aria-describedby={describedBy(fieldErrors.confirm && AUTH_ERROR_IDS.confirm)}
              />
              {fieldErrors.confirm && (
                <p id={AUTH_ERROR_IDS.confirm} role="alert" className="text-sm text-rose-400" style={{ margin: 0 }}>
                  {fieldErrors.confirm}
                </p>
              )}
            </div>

            {formError && (
              <p
                id={AUTH_ERROR_IDS.form}
                role="alert"
                tabIndex={-1}
                className="text-sm text-rose-400"
                style={{ margin: 0 }}
              >
                {formError}
              </p>
            )}

            <button type="submit" className="btn btn-primary btn-block" style={{ minHeight: 44 }} disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <Link to="/login" className="btn btn-ghost" style={{ fontSize: 12.5, marginTop: 2 }}>
            Already have an account? Sign in
          </Link>
        </div>

        <p className="text-center text-muted" style={{ fontSize: 11 }}>
          Self-hosted with ❤️ · campfire v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
