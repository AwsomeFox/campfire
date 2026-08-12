import { useTranslation } from 'react-i18next';
/**
 * Password reset requests card — extracted from AdminPage.tsx as part of the
 * /admin/* page split (issue #350). Lives on /admin/users.
 *
 * Forgot-password (issue #10): users file requests from the login screen;
 * approving one mints a ONE-TIME reset code (shown here once) that the admin
 * relays out-of-band. The admin never learns the user's new password.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PasswordResetRequest, PasswordResetApproval } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { joinPublicBase } from '../../lib/public-base';
import { Card, Btn } from '../../components/ui';
import { CopyControl } from '../../components/CopyControl';
import { formatDateTime, formatTime } from '../../lib/format';

export function ResetRequestsCard() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<PasswordResetRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Raw one-time codes by request id — only lives in this render; gone on reload.
  const [codes, setCodes] = useState<Record<number, PasswordResetApproval>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await api.get<PasswordResetRequest[]>(`${API}/users/reset-requests`));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: number) {
    setBusyId(id);
    setError(null);
    try {
      const approval = await api.post<PasswordResetApproval>(`${API}/users/reset-requests/${id}/approve`);
      setCodes((prev) => ({ ...prev, [id]: approval }));
      await load();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(id: number) {
    setBusyId(id);
    setError(null);
    try {
      await api.delete(`${API}/users/reset-requests/${id}`);
      setCodes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await load();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Password reset requests</h2>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!requests || requests.length === 0 ? (
        <p className="text-xs text-secondary">
          None right now. When someone taps &ldquo;Forgot password?&rdquo; on the sign-in screen, their request shows up
          here — approve it to get a one-time reset code to hand to them.
        </p>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => {
            const approval = codes[r.id];
            const resetUrl = approval
              ? `${window.location.origin}${joinPublicBase('/reset-password')}?code=${approval.code}`
              : null;
            const resetLinkId = `reset-link-${r.id}`;
            return (
            <div key={r.id} className="cf-inset p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {r.username}
                    {r.displayName && <span className="text-secondary font-normal"> · {r.displayName}</span>}
                  </p>
                  <p className="text-[11px] text-secondary">
                    Requested {formatDateTime(r.requestedAt)}
                    {r.status === 'approved' && r.expiresAt && (
                      <> · code expires {formatTime(r.expiresAt)}</>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Btn density="xs"
                    className="text-xs"
                    onClick={() => approve(r.id)}
                    disabled={busyId === r.id}
                  >
                    {r.status === 'approved' ? 'New code' : 'Approve'}
                  </Btn>
                  <Btn density="xs" ghost className="text-xs" onClick={() => dismiss(r.id)} disabled={busyId === r.id}>
                    Dismiss
                  </Btn>
                </div>
              </div>
              {approval && resetUrl && (
                <div className="border border-[var(--color-warning)]/30 rounded p-2.5 space-y-1">
                  <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
                    One-time reset link — shown once, give it to {approval.request.username} now
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <code id={resetLinkId} className="text-xs text-emerald-400 break-all">
                      {resetUrl}
                    </code>
                    <CopyControl density="xs"
                      text={resetUrl}
                      selectTargetId={resetLinkId}
                      label="Copy reset link"
                      ghost
                      className="text-[11px]"
                      successAnnouncement="Reset link copied to clipboard."
                      failureAnnouncement="Copy failed. Clipboard blocked — select the link and copy it manually."
                    />
                  </div>
                  <p className="text-[11px] text-secondary">
                    Expires {formatTime(approval.expiresAt)} · single-use · they set their own
                    password at /reset-password.
                  </p>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
