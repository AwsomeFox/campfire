/**
 * Forgot-password page (issue #10). This server may have no mail transport,
 * so the flow is admin-approved: request a reset here, a server admin approves
 * it and hands you a one-time reset code out-of-band, then you redeem the code
 * below to set a new password. Deep-linkable as /reset-password?code=... so an
 * admin can send a ready-to-use link along with the code.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, API } from '../../lib/api';
import { PasswordInput } from '../../components/PasswordInput';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Step 1 — file a request.
  const [username, setUsername] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  // Step 2 — redeem a code.
  const [code, setCode] = useState(searchParams.get('code') ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    setRequestError(null);
    setRequesting(true);
    try {
      await api.post(`${API}/auth/reset-request`, { username: username.trim() });
      setRequested(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setRequestError('Too many attempts — wait a minute and try again.');
      } else {
        setRequestError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setRequesting(false);
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    setConfirmError(null);
    setConfirming(true);
    try {
      await api.post(`${API}/auth/reset-confirm`, { code: code.trim(), newPassword });
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setConfirmError('That code is invalid or has expired — ask your admin for a fresh one.');
      } else if (err instanceof ApiError && err.status === 429) {
        setConfirmError('Too many attempts — wait a minute and try again.');
      } else {
        setConfirmError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setConfirming(false);
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
      <div className="flex flex-col gap-4" style={{ width: 'min(420px, 100%)' }}>
        <div className="card elev-md" style={{ padding: '28px 26px', gap: 14 }}>
          <div>
            <h3 style={{ margin: 0 }}>Reset your password</h3>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              This server has no email — a server admin approves your request and gives you a one-time reset code.
            </p>
          </div>

          {requested ? (
            <p className="text-sm" style={{ color: 'var(--color-accent)' }}>
              Request received. Ask your server admin to approve it — they&apos;ll give you a reset code to enter below.
            </p>
          ) : (
            <form onSubmit={onRequest} className="flex flex-col gap-3">
              <div className="field">
                <label htmlFor="reset-username">Username</label>
                <input
                  id="reset-username"
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus={!code}
                  required
                />
              </div>
              {requestError && <p className="text-sm text-rose-400">{requestError}</p>}
              <button type="submit" className="btn btn-secondary btn-block" style={{ minHeight: 44 }} disabled={requesting}>
                {requesting ? 'Sending…' : 'Request a reset'}
              </button>
            </form>
          )}

          <div className="hr" style={{ margin: 0 }} />

          <div>
            <p className="text-sm" style={{ margin: 0, fontWeight: 600 }}>
              Already have a reset code?
            </p>
          </div>
          {done ? (
            <p className="text-sm" style={{ color: 'var(--color-accent)' }}>
              Password updated — taking you to sign in…
            </p>
          ) : (
            <form onSubmit={onConfirm} className="flex flex-col gap-3">
              <div className="field">
                <label htmlFor="reset-code">Reset code</label>
                <input
                  id="reset-code"
                  className="input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="cf_reset_…"
                  autoComplete="off"
                  autoFocus={Boolean(code)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="reset-new-password">New password</label>
                <PasswordInput
                  id="reset-new-password"
                  className="input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  autoComplete="new-password"
                  revealNoun="new password"
                  required
                  minLength={8}
                />
              </div>
              {confirmError && <p className="text-sm text-rose-400">{confirmError}</p>}
              <button
                type="submit"
                className="btn btn-primary btn-block"
                style={{ minHeight: 44 }}
                disabled={confirming || newPassword.length < 8 || !code.trim()}
              >
                {confirming ? 'Resetting…' : 'Set new password'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center" style={{ fontSize: 12 }}>
          <Link to="/login" className="text-muted">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
