/**
 * Invite landing page — /join/:code (issue #7, DM invite links / join codes).
 * Same card-on-radial-ground language as LoginPage/SetupPage. Resolves the code
 * via the public GET /invites/:code, then either:
 *  - signed out: create-account form -> POST /invites/:code/accept (account +
 *    membership + session in one call), or
 *  - signed in: one-click join -> POST /invites/:code/join,
 * and lands in the campaign.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { InvitePreview } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';

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
  const [loading, setLoading] = useState(true);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api.get<InvitePreview>(`${API}/invites/${encodeURIComponent(code)}`);
        if (!cancelled) setPreview(p);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? 'This invite link is invalid or no longer active. Ask your DM for a fresh one.'
              : 'Couldn’t check the invite. Is the server reachable?',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const alreadyMember = Boolean(preview && me?.memberships.some((m) => m.campaignId === preview.campaignId));

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
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
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
      await api.post(`${API}/invites/${encodeURIComponent(code)}/accept`, {
        username,
        password,
        displayName: displayName.trim() || undefined,
      });
      await refresh();
      navigate(`/c/${preview.campaignId}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('That username is taken — pick another, or sign in with it instead.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError('Local sign-in is disabled on this server — ask the admin for an account.');
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

          {loading || !ready ? (
            <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
              Checking your invite…
            </p>
          ) : loadError ? (
            <>
              <div>
                <h3 style={{ margin: 0 }}>Campfire</h3>
                <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {loadError}
                </p>
              </div>
              <Link to="/login" className="btn btn-secondary btn-block" style={{ minHeight: 44 }}>
                Go to sign in
              </Link>
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
                  {error && <p className="text-sm text-rose-400 m-0">{error}</p>}
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

                  {error && <p className="text-sm text-rose-400 m-0">{error}</p>}

                  <button type="submit" className="btn btn-primary btn-block" style={{ minHeight: 44 }} disabled={submitting}>
                    {submitting ? 'Pulling up a chair…' : 'Create account & join'}
                  </button>
                  <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
                    Already have an account? <Link to="/login">Sign in</Link> first, then open this link again.
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
