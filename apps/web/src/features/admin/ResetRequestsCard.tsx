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
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn } from '../../components/ui';
import { CopyControl } from '../../components/CopyControl';

export function ResetRequestsCard() {
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
      setError(err instanceof ApiError ? err.message : "Couldn't load reset requests.");
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
      setError(err instanceof ApiError ? err.message : "Couldn't approve request.");
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
      setError(err instanceof ApiError ? err.message : "Couldn't dismiss request.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Password reset requests</h2>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!requests || requests.length === 0 ? (
        <p className="text-xs text-slate-500">
          None right now. When someone taps &ldquo;Forgot password?&rdquo; on the sign-in screen, their request shows up
          here — approve it to get a one-time reset code to hand to them.
        </p>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => (
            <div key={r.id} className="cf-inset p-3.5 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {r.username}
                    {r.displayName && <span className="text-slate-500 font-normal"> · {r.displayName}</span>}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Requested {new Date(r.requestedAt).toLocaleString()}
                    {r.status === 'approved' && r.expiresAt && (
                      <> · code expires {new Date(r.expiresAt).toLocaleTimeString()}</>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Btn
                    className="!min-h-0 !py-1.5 text-xs"
                    onClick={() => approve(r.id)}
                    disabled={busyId === r.id}
                  >
                    {r.status === 'approved' ? 'New code' : 'Approve'}
                  </Btn>
                  <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => dismiss(r.id)} disabled={busyId === r.id}>
                    Dismiss
                  </Btn>
                </div>
              </div>
              {codes[r.id] && (
                <div className="border border-amber-500/30 rounded p-2.5 space-y-1">
                  <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
                    One-time reset code — shown once, give it to {codes[r.id].request.username} now
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <code id={`reset-code-${r.id}`} className="text-xs text-emerald-400 break-all">
                      {codes[r.id].code}
                    </code>
                    <CopyControl
                      text={`${window.location.origin}/reset-password?code=${codes[r.id].code}`}
                      selectTargetId={`reset-code-${r.id}`}
                      label="Copy reset link"
                      ghost
                      className="!min-h-0 !py-1 text-[11px]"
                      successAnnouncement="Reset link copied to clipboard."
                      failureAnnouncement="Copy failed. Clipboard blocked — select the code and copy it manually."
                    />
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Expires {new Date(codes[r.id].expiresAt).toLocaleTimeString()} · single-use · they set their own
                    password at /reset-password.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
