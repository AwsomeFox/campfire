/**
 * Sign-in + landing screen. A visitor's first impression of a Campfire server:
 * a compact value statement followed by authentication and the fuller pitch.
 * Mirrors design/claude-design/Campfire.dc.html's "Login" screen aesthetic —
 * flame mark on a radial-gradient ground — extended into a two-column landing on
 * wide screens while preserving one semantic intro -> auth -> pitch order at
 * every viewport. SSO is first when OIDC is configured; local authentication is
 * the primary option when OIDC is off and secondary/collapsible when both are available.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Me } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAuthStatus } from '../../app/AuthStatusGate';
import { useAnnounce } from '../../components/Announcer';
import { GameIcon } from '../../components/GameIcon';

function FlameMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
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

/** The value-prop highlights shown on the landing hero. Icons degrade gracefully. */
export const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: 'rolling-dices',
    title: 'An AI Dungeon Master',
    body: 'Two modes, plainly different. As a co-DM it only proposes — every change waits in a queue for a human DM to approve before anything is applied. In Driver mode it holds the DM seat and acts directly — narrating, rolling dice, moving HP and conditions, and running the table within the limits you set.',
  },
  {
    icon: 'treasure-map',
    title: 'Battle maps & fog of war',
    body: 'Grid maps, tokens, initiative and HP bands — with the monster HP and hidden NPCs only the DM can see.',
  },
  {
    icon: 'open-book',
    title: 'Real rule systems',
    body: 'D&D 5e, Pathfinder 2e, Open Legend and more — statblocks, spells and rules lookups, installed from open sources.',
  },
  {
    icon: 'quill-ink',
    title: 'Your whole world, in one place',
    body: 'Quests, NPCs, factions, locations, a living timeline, session prep and auto-drafted recaps.',
  },
  {
    icon: 'processor',
    title: 'Agent-operable over MCP',
    body: 'Run an entire campaign from an AI agent with a scoped token — every action audited, every write role-gated.',
  },
  {
    icon: 'shield',
    title: 'Self-hosted & private',
    body: 'Your table, your server, your data. No lock-in — export the whole campaign to JSON or Markdown anytime.',
  },
];

function BrandIntro() {
  return (
    <header className="login-intro">
      <div className="flex items-center gap-3">
        <FlameMark size={36} />
        <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--color-text)' }}>Campfire</span>
      </div>

      <h1>Gather your whole campaign around one fire.</h1>
      <p className="text-muted">
        The self-hosted home for your tabletop game — private, shared, and ready when your table is.
      </p>
    </header>
  );
}

function LandingPitch() {
  return (
    <section className="login-pitch" aria-labelledby="login-pitch-title">
      <h2 id="login-pitch-title">Everything your table needs</h2>
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex gap-3">
            <span
              className="shrink-0 grid place-items-center"
              style={{
                width: 34,
                height: 34,
                borderRadius: 'var(--radius-md, 10px)',
                background: 'var(--color-accent-900)',
                border: '1px solid var(--color-divider)',
              }}
            >
              <GameIcon slug={f.icon} size={19} className="text-[var(--color-accent)]" title={f.title} />
            </span>
            <div className="flex flex-col" style={{ gap: 2 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text)' }}>{f.title}</span>
              <span className="text-muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{f.body}</span>
            </div>
          </div>
        ))}
      </div>

      <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
        Open-source and free to self-host · your data never leaves your server.
      </p>
    </section>
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
  focusOnMount = false,
}: {
  submitting: boolean;
  onSubmit: (e: FormEvent) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  primary: boolean;
  focusOnMount?: boolean;
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
          autoFocus={primary || focusOnMount}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'login-error' : undefined}
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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'login-error' : undefined}
          required
        />
      </div>

      {error && <p id="login-error" role="alert" className="text-sm text-rose-400" style={{ margin: 0 }}>{error}</p>}

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
  const { t } = useTranslation();
  const { status, loading } = useAuthStatus();
  const { me, ready, refresh } = useAuth();
  const announce = useAnnounce();
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
  const [showLocalForm, setShowLocalForm] = useState(
    () => new URLSearchParams(location.search).get('local') === '1',
  );

  // Issue #506: Layout's sign-out flow lands here via `navigate(..., { state:
  // { signedOut: true } })`. Move focus to the "Sign in" heading so keyboard and
  // screen-reader users get a clear landing point confirming the account is
  // gone — without this, focus is left wherever it was on the DOM node React
  // Router just removed (often nowhere, per WCAG 2.4.3). A normal cold visit or
  // a session-expiry bounce doesn't carry this flag, so the local form's own
  // autoFocus (aimed at the username field) is left alone for those.
  //
  // Assertive "Signed out" is announced here (not in Layout.onLogout) so it
  // survives AuthedLayout/Layout unmount clears from issue #434.
  const cameFromSignOut = Boolean((location.state as { signedOut?: boolean } | null)?.signedOut);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const announcedSignOut = useRef(false);
  // useLayoutEffect so heading focus wins over a later paint; skip username
  // autoFocus when cameFromSignOut (see LocalLoginForm below).
  useLayoutEffect(() => {
    if (cameFromSignOut) headingRef.current?.focus();
  }, [cameFromSignOut]);

  useEffect(() => {
    if (!cameFromSignOut || announcedSignOut.current) return;
    announcedSignOut.current = true;
    announce(t('nav.signedOutAnnouncement'), { assertive: true });
  }, [cameFromSignOut, announce, t]);

  // React Router keeps this page mounted for query-only navigation. Mirror the
  // URL on back/forward and recovery-page navigation instead of treating the
  // initial query string as immutable component state.
  useEffect(() => {
    setShowLocalForm(new URLSearchParams(location.search).get('local') === '1');
  }, [location.search]);

  if (!loading && status?.setupRequired) {
    return <Navigate to="/setup" replace />;
  }
  // During a successful submit, onSubmit owns the single history-replacing
  // navigation after refreshing identity. Do not race it with this guard.
  if (!submitting && !loading && ready && me) {
    return <Navigate to={redirectTo} replace />;
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
  const localLoginEnabled = Boolean(status?.localLoginEnabled);
  const oidcProviderName = status?.oidcProviderName?.trim() || 'SSO';
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

  const authCard = (
    <div className="login-auth-stack">
      <div className="card elev-md items-center text-center login-auth-card">
        <div className="login-auth-heading">
          <span className="login-auth-mark" aria-hidden="true"><FlameMark /></span>
          <div>
            <h2 id="login-title" ref={headingRef} tabIndex={-1} style={{ margin: 0 }}>
              Sign in
            </h2>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              to your Campfire server
            </p>
          </div>
        </div>

        {loading ? (
          <p role="status" className="text-muted" style={{ margin: 0, fontSize: 13 }}>
            Checking sign-in options…
          </p>
        ) : oidcEnabled ? (
          <>
            <a href={oidcLoginHref} className="btn btn-primary btn-block" style={{ minHeight: 44 }}>
              Sign in with {oidcProviderName}
            </a>
            <p className="text-muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
              SSO creates your Campfire account.
              <br />
              Campaign access and DM, player, or viewer roles are assigned inside Campfire.
            </p>
            {showLocalForm ? (
              <div className="w-full flex flex-col gap-3" style={{ marginTop: 6 }}>
                <div className="hr" style={{ margin: 0 }} />
                {!localLoginEnabled && (
                  <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                    Local sign-in is restricted to server administrators.
                  </p>
                )}
                <LocalLoginForm
                  submitting={submitting}
                  onSubmit={onSubmit}
                  username={username}
                  setUsername={setUsername}
                  password={password}
                  setPassword={setPassword}
                  error={error}
                  primary={false}
                  focusOnMount
                />
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12.5, marginTop: 2 }}
                onClick={() => setShowLocalForm(true)}
              >
                {localLoginEnabled
                  ? 'Sign in with username & password instead'
                  : 'Administrator local sign-in'}
              </button>
            )}
          </>
        ) : (
          <div className="w-full">
            {!localLoginEnabled && (
              <p className="text-muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
                Local sign-in is restricted to server administrators.
              </p>
            )}
            <LocalLoginForm
              submitting={submitting}
              onSubmit={onSubmit}
              username={username}
              setUsername={setUsername}
              password={password}
              setPassword={setPassword}
              error={error}
              primary={!cameFromSignOut}
            />
          </div>
        )}

        {!loading && signupEnabled && (
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

      <p className="text-center text-muted" style={{ margin: 0, fontSize: 11 }}>
        Self-hosted with ❤️ · campfire v{__APP_VERSION__}
      </p>
    </div>
  );

  return (
    <main
      className="login-page"
      style={{
        background: 'radial-gradient(90% 55% at 15% 0%, var(--color-neutral-900) 0%, var(--color-bg) 65%)',
      }}
    >
      <div className="login-shell">
        <BrandIntro />
        <section className="login-auth" aria-labelledby="login-title">
          {authCard}
        </section>
        <LandingPitch />
      </div>
    </main>
  );
}
