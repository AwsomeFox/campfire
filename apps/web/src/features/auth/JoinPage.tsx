/**
 * Invite landing page — /join/:code (issue #7, DM invite links / join codes).
 * Same card-on-radial-ground language as LoginPage/SetupPage. Resolves the code
 * via the public GET /invites/:code, then either:
 *  - signed out: create-account form -> POST /invites/:code/accept (account +
 *    membership + session in one call), or
 *  - signed in: one-click join -> POST /invites/:code/join,
 * and lands in the campaign.
 */
import { Card } from '../../components/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { InvitePreview } from '@campfire/schema';
import { api, ApiError, API, isTransientError } from '../../lib/api';
import { loginHrefWithReturn } from '../../lib/safeInternalPath';
import { useAuth } from '../../app/auth';
import { PasswordInput } from '../../components/PasswordInput';
import { BrandMark } from '../../components/BrandMark';
import { CharterPreviewPanel } from '../session-zero/CharterPreviewPanel';
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

const ROLE_BLURB: Record<InvitePreview['role'], string> = {
  player: 'a player',
  viewer: 'a viewer',
};

/**
 * Issue #600: join/accept both use HTTP 409 for "already a member" / "username taken"
 * AND for a stale charter version. The charter conflict message is stable server copy
 * from `assertCharterAcknowledged` — match on it so the UI does not mis-route the user
 * into the campaign or claim their username is taken.
 */
function isStaleCharterConflict(err: ApiError): boolean {
  return /session-zero charter you must acknowledge/i.test(err.message);
}

/**
 * Issue #597: the join page must say what the seat can DO before you accept it, not
 * just name its role. "Viewer" was not an answer — and until #597 the server did not
 * behave the way the word implied. Rendered straight from the server's
 * `permissions` object so the preview and the enforcement can never disagree.
 */
const PERMISSION_LABELS: ReadonlyArray<{ key: keyof InvitePreview['permissions']; label: string }> = [
  { key: 'canComment', label: 'Post comments on threads' },
  { key: 'canShareNotes', label: 'Share notes with the party or the DM' },
  { key: 'canWhisper', label: 'Send private whispers to members' },
  { key: 'canSubmitToDmInbox', label: 'Send items to the DM inbox' },
  { key: 'canKeepPrivateNotes', label: 'Keep private notes only you can see' },
  { key: 'canEditCampaignContent', label: 'Add and edit campaign content' },
  { key: 'canModerate', label: 'Moderate the table' },
];

function InvitePermissions({ permissions }: { permissions: InvitePreview['permissions'] }) {
  return (
    <div className="w-full" style={{ textAlign: 'left' }}>
      <p className="text-muted" style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600 }}>
        {permissions.readOnly ? 'This seat is read-only. You will be able to:' : 'At this table you will be able to:'}
      </p>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {PERMISSION_LABELS.map(({ key, label }) => (
          <li
            key={key}
            className={permissions[key] ? '' : 'text-muted'}
            style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline' }}
          >
            <span aria-hidden="true">{permissions[key] ? '\u2713' : '\u2717'}</span>
            <span>
              {label}
              <span className="sr-only">{permissions[key] ? ' — allowed' : ' — not allowed'}</span>
            </span>
          </li>
        ))}
      </ul>
      {permissions.readOnly && (
        <p className="text-muted" style={{ margin: '6px 0 0', fontSize: 11 }}>
          A DM can later grant you the interactive-guest capability if the table wants you taking part in discussion.
        </p>
      )}
    </div>
  );
}

export function JoinPage() {
  const { t } = useTranslation();
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
  // Issue #600: consent must be an explicit act, so the join button stays disabled until
  // the box is ticked. The server enforces the same gate — this is the affordance, not
  // the control.
  const [charterAccepted, setCharterAccepted] = useState(false);
  const [declined, setDeclined] = useState(false);

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
  const needsCharterConsent = Boolean(preview?.charter && !alreadyMember);
  const charterConsentMissing = needsCharterConsent && !charterAccepted;
  // Carry `/join/:code` through local/OIDC login so existing users resume the
  // invite preview instead of losing the link (issue #478).
  const loginHref = loginHrefWithReturn(`/join/${code}`);

  /** Issue #600: a recorded refusal rather than a closed tab. */
  async function declineInvite() {
    setError(null);
    setSubmitting(true);
    try {
      await api.post(`${API}/invites/${encodeURIComponent(code)}/decline`, { note: '' });
      setDeclined(true);
    } catch (err) {
      setError({
        kind: 'form',
        message: err instanceof ApiError ? err.message : AUTH_GENERIC_ERROR,
      });
    } finally {
      setSubmitting(false);
    }
  }

  /** Preview went stale while the form was open — reload it and require a fresh tick. */
  async function handleStaleCharterConflict() {
    setCharterAccepted(false);
    setDeclined(false);
    await loadPreview();
    setError({
      kind: 'form',
      message: t('sessionZero.join.charterChanged'),
    });
  }

  async function joinAsCurrentUser() {
    if (!preview) return;
    if (charterConsentMissing) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post(`${API}/invites/${encodeURIComponent(code)}/join`, {
        acknowledgeVersion: preview.charter ? preview.charter.version : undefined,
      });
      await refresh();
      navigate(`/c/${preview.campaignId}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isStaleCharterConflict(err)) {
        await handleStaleCharterConflict();
      } else if (err instanceof ApiError && err.status === 409) {
        // Genuine already-a-member conflict — land them in the campaign.
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
    if (charterConsentMissing) return;
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
        acknowledgeVersion: preview.charter ? preview.charter.version : undefined,
      });
      await refresh();
      navigate(`/c/${preview.campaignId}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isStaleCharterConflict(err)) {
        await handleStaleCharterConflict();
      } else if (err instanceof ApiError && err.status === 409) {
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
        <Card density="compact" elev="md" className="items-center text-center" style={{ padding: '28px 26px', gap: 14 }}>
          <BrandMark />

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

              {!alreadyMember && preview.permissions && (
                <InvitePermissions permissions={preview.permissions} />
              )}

              {/*
                Issue #600 — the boundaries, before the commitment. `charter` is null for a
                campaign that never published a version, in which case this whole block is
                absent and the join flow is exactly what it was.
              */}
              {preview.charter && !alreadyMember && (
                <div className="w-full flex flex-col gap-3">
                  <CharterPreviewPanel charter={preview.charter} />
                  <label className="flex items-start gap-2 text-sm" style={{ textAlign: 'start' }}>
                    <input
                      type="checkbox"
                      checked={charterAccepted}
                      onChange={(e) => setCharterAccepted(e.target.checked)}
                      style={{ marginTop: 3 }}
                    />
                    <span>{t('sessionZero.join.charterAgree')}</span>
                  </label>
                  {me && (
                    declined ? (
                      <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                        {t('sessionZero.join.declinedMessage')}
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={submitting}
                        onClick={declineInvite}
                      >
                        {t('sessionZero.join.decline')}
                      </button>
                    )
                  )}
                </div>
              )}

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
                      disabled={submitting || charterConsentMissing}
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

                  <button
                    type="submit"
                    className="btn btn-primary btn-block"
                    style={{ minHeight: 44 }}
                    disabled={submitting || charterConsentMissing}
                  >
                    {submitting ? 'Pulling up a chair…' : 'Create account & join'}
                  </button>
                  <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
                    Already have an account? <Link to={loginHref}>Sign in</Link> — you&rsquo;ll return here to join.
                  </p>
                </form>
              )}
            </>
          ) : null}
        </Card>

        <p className="text-center text-muted" style={{ fontSize: 11 }}>
          Self-hosted with ❤️ · campfire v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}

export default JoinPage;
