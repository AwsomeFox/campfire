/**
 * Invite landing page — /join/:code (issue #7, DM invite links / join codes).
 * Same card-on-radial-ground language as LoginPage/SetupPage. Resolves the code
 * via the public GET /invites/:code, then either:
 *  - signed out: create-account form -> POST /invites/:code/accept (account +
 *    membership + session in one call), or
 *  - signed in: one-click join -> POST /invites/:code/join,
 * and lands in the campaign.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { InvitePreview } from '@campfire/schema';
import { api, ApiError, API, isTransientError } from '../../lib/api';
import { loginHrefWithReturn } from '../../lib/safeInternalPath';
import { useAuth } from '../../app/auth';
import { PasswordInput } from '../../components/PasswordInput';
import {
  AUTH_ERROR_IDS,
  AUTH_FIELD_IDS,
  AUTH_GENERIC_ERROR,
  AUTH_LOCAL_DISABLED_ERROR,
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

const ROLE_BLURB: Record<InvitePreview['role'], string> = {
  player: 'a player',
  viewer: 'a viewer',
};

export function JoinPage() {
  const { code = '' } = useParams<{ code: string }>();
  const { me, ready, refresh } = useAuth();
  const navigate = useNavigate();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transient, setTransient] = useState(false);
  const [loading, setLoading] = useState(true);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<AuthErrorState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useLayoutEffect(() => {
    if (error) focusAuthError(error);
  }, [error]);

  // Resolve the invite code via the public preview endpoint. Kept as a stable
  // callback so the Retry button can re-run the SAME fetch (preserving the join
  // code) without abandoning the join link (issue #709). Transient failures
  // (network/offline/5xx/429/408) set `transient=true` and surface a Retry;
  // persistent failures (404 invalid/expired/used, other 4xx) set the
  // definitive error with no retry — retrying a 404 invite won't bring it back.
  const controllerRef = useRef<AbortController | null>(null);
  const loadPreview = useCallback(async () => {
    // Abort any in-flight load (prior mount or a previous Retry click) so two
    // concurrent fetches can never race to clobber state.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    setLoading(true);
    setError(null);
    setTransient(false);
    try {
      const p = await api.get<InvitePreview>(`${API}/invites/${encodeURIComponent(code)}`, { signal });
      if (!signal.aborted) {
        setPreview(p);
        setLoadError(null);
      }
    } catch (err) {
      if (signal.aborted) return;
      if (isTransientError(err)) {
        // The request never reached a definitive answer — don't abandon the
        // join link. Offer a Retry that re-resolves the SAME code.
        setTransient(true);
        setLoadError('Couldn’t load this invite. Check your connection and try again.');
      } else {
        // Persistent: the server answered definitively. Unknown/expired/used
        // codes all collapse to 404 per the controller — anything else here is
        // a 4xx that retrying won't change.
        setTransient(false);
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? 'This invite link is invalid or no longer active. Ask your DM for a fresh one.'
            : err instanceof ApiError
              ? err.message
              : 'This invite could not be loaded.',
        );
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    void loadPreview();
    return () => controllerRef.current?.abort();
  }, [loadPreview]);

  const alreadyMember = Boolean(preview && me?.memberships.some((m) => m.campaignId === preview.campaignId));
  // Carry `/join/:code` through local/OIDC login so existing users resume the
  // invite preview instead of losing the link (issue #478).
  const loginHref = loginHrefWithReturn(`/join/${code}`);

  async function joinAsCurrentUser() {
    if (!preview) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post(`${API}/invites/${encodeURIComponent(code)}/join`);
      await refresh();
      navigate(`/c/${preview.campaignId}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        navigate(`/c/${preview.campaignId}`, { replace: true });
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setError(null);

    const clientError = validateNewAccountFields({ username, password, confirm });
    if (clientError) {
      setError(clientError);
      return;
    }

    setSubmitting(true);
    try {
      await api.post(`${API}/invites/${encodeURIComponent(code)}/accept`, {
        username,
        password,
        displayName: displayName.trim() || undefined,
      });
      await refresh();
      navigate(`/c/${preview.campaignId}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError({
          kind: 'fields',
          fields: {
            username: 'That username is taken — pick another, or sign in with it instead.',
          },
          focus: 'username',
        });
      } else if (err instanceof ApiError && err.status === 403) {
        setError({ kind: 'form', message: AUTH_LOCAL_DISABLED_ERROR });
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

          {loading || !ready ? (
            <p
              className="text-muted"
              style={{ margin: 0, fontSize: 13 }}
              role="status"
              aria-live="polite"
            >
              {loading ? 'Checking your invite…' : 'Almost there…'}
            </p>
          ) : loadError ? (
            <>
              <div role="alert" aria-live="assertive">
                <h3 style={{ margin: 0 }}>Campfire</h3>
                <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {loadError}
                </p>
              </div>
              {transient ? (
                <div className="w-full flex flex-col gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    style={{ minHeight: 44 }}
                    onClick={() => void loadPreview()}
                  >
                    Retry
                  </button>
                  <Link
                    to={loginHref}
                    className="btn btn-secondary btn-block"
                    style={{ minHeight: 44 }}
                  >
                    Go to sign in
                  </Link>
                </div>
              ) : (
                <Link to={loginHref} className="btn btn-secondary btn-block" style={{ minHeight: 44 }}>
                  Go to sign in
                </Link>
              )}
            </>
          ) : preview ? (
            <>
              <div>
                <h3 style={{ margin: 0 }}>You&rsquo;re invited to {preview.campaignName}</h3>
                <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {alreadyMember
                    ? 'You already have a seat at this table.'
                    : `Joining as ${ROLE_BLURB[preview.role]}.`}
                </p>
              </div>

              {me ? (
                <div className="w-full flex flex-col gap-3">
                  {formError && (
                    <p
                      id={AUTH_ERROR_IDS.form}
                      role="alert"
                      tabIndex={-1}
                      className="text-sm text-rose-400 m-0"
                    >
                      {formError}
                    </p>
                  )}
                  {alreadyMember ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      style={{ minHeight: 44 }}
                      onClick={() => navigate(`/c/${preview.campaignId}`)}
                    >
                      Open campaign
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      style={{ minHeight: 44 }}
                      disabled={submitting}
                      onClick={joinAsCurrentUser}
                    >
                      {submitting
                        ? 'Joining…'
                        : `Join as ${me.user.displayName || me.user.username}`}
                    </button>
                  )}
                </div>
              ) : (
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
                      <p id={AUTH_ERROR_IDS.username} role="alert" className="text-sm text-rose-400 m-0">
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
                      <p id={AUTH_ERROR_IDS.password} role="alert" className="text-sm text-rose-400 m-0">
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
                      <p id={AUTH_ERROR_IDS.confirm} role="alert" className="text-sm text-rose-400 m-0">
                        {fieldErrors.confirm}
                      </p>
                    )}
                  </div>

                  {formError && (
                    <p
                      id={AUTH_ERROR_IDS.form}
                      role="alert"
                      tabIndex={-1}
                      className="text-sm text-rose-400 m-0"
                    >
                      {formError}
                    </p>
                  )}

                  <button type="submit" className="btn btn-primary btn-block" style={{ minHeight: 44 }} disabled={submitting}>
                    {submitting ? 'Pulling up a chair…' : 'Create account & join'}
                  </button>
                  <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
                    Already have an account? <Link to={loginHref}>Sign in</Link> — you&rsquo;ll return here to join.
                  </p>
                </form>
              )}
            </>
          ) : null}
        </div>

        <p className="text-center text-muted" style={{ fontSize: 11 }}>
          Self-hosted with ❤️ · campfire v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}

export default JoinPage;
