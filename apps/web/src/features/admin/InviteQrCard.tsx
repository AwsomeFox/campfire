/**
 * QR-code handoff card for campaign invite links (issue #822).
 *
 * Shows a scannable QR code for each active invite alongside role, expiry,
 * remaining uses, and a bearer-link security warning. Provides full-screen
 * display, PNG download, print, and copy-link actions.
 *
 * Inactive invites (expired, exhausted, revoked) show a non-scannable overlay
 * so a displayed QR is never misleadingly available. The textual URL is always
 * shown as an accessible fallback.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { CampaignInvite } from '@campfire/schema';

// --- Helpers ----------------------------------------------------------------

function inviteUrl(code: string): string {
  return `${window.location.origin}/join/${code}`;
}

/** Whether the invite can still be used (not expired and not exhausted). */
function isInviteActive(invite: Pick<CampaignInvite, 'expiresAt' | 'maxUses' | 'useCount'>): boolean {
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return false;
  if (invite.maxUses != null && invite.useCount >= invite.maxUses) return false;
  return true;
}

function remainingLabel(invite: Pick<CampaignInvite, 'useCount' | 'maxUses'>): string {
  if (invite.maxUses == null) return `${invite.useCount} used (unlimited)`;
  const remaining = Math.max(0, invite.maxUses - invite.useCount);
  return `${remaining}/${invite.maxUses} remaining`;
}

function expiryLabel(iso: string): string {
  const msLeft = new Date(iso).getTime() - Date.now();
  if (msLeft <= 0) return 'Expired';
  const hours = Math.ceil(msLeft / 3_600_000);
  if (hours < 24) return `Expires in ${hours}h`;
  return `Expires in ${Math.ceil(hours / 24)}d`;
}

// --- Props ------------------------------------------------------------------

export interface InviteQrCardProps {
  invite: CampaignInvite;
}

// --- Component --------------------------------------------------------------

export function InviteQrCard({ invite }: InviteQrCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = isInviteActive(invite);
  const url = inviteUrl(invite.code);

  // Render QR to canvas whenever invite code changes or activity status changes
  const renderQr = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!active) {
      // Clear canvas for inactive invites
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 200;
        canvas.height = 200;
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = '#64748b';
        ctx.font = 'bold 16px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Inactive', 100, 100);
      }
      return;
    }

    try {
      await QRCode.toCanvas(canvas, url, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
      setError(null);
    } catch (err) {
      setError('Failed to generate QR code');
    }
  }, [active, url]);

  useEffect(() => {
    void renderQr();
  }, [renderQr]);

  // --- Actions ---------------------------------------------------------------

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard unavailable — copy from the text field instead.');
    }
  }

  function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `invite-${invite.code}.png`;
    a.click();
  }

  function handlePrint() {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const dataUrl = canvas.toDataURL('image/png');
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head><title>Invite QR Code</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui,sans-serif;">
          <img src="${dataUrl}" alt="QR code for invite link" style="width:300px;height:300px;" />
          <p style="margin-top:1rem;font-size:14px;color:#333;">${url}</p>
          <p style="font-size:12px;color:#666;">Role: ${invite.role} | ${expiryLabel(invite.expiresAt)} | ${remainingLabel(invite)}</p>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  }

  function handleFullscreen() {
    setFullscreen(true);
  }

  function handleExitFullscreen() {
    setFullscreen(false);
  }

  // Handle Escape to exit fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setFullscreen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  // --- Render ----------------------------------------------------------------

  const roleLabel = invite.role === 'player' ? 'Player' : 'Viewer';
  const statusLabel = !active
    ? new Date(invite.expiresAt).getTime() <= Date.now()
      ? 'Expired'
      : 'Exhausted'
    : null;

  return (
    <>
      <div
        className="flex flex-col sm:flex-row gap-3 items-start p-3 rounded-lg border border-slate-700 bg-slate-900/50"
        data-testid="invite-qr-card"
        data-invite-id={invite.id}
        data-invite-active={active}
      >
        {/* QR code */}
        <div className="relative shrink-0 self-center sm:self-start">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="QR code for invite link"
            className="rounded"
            width={200}
            height={200}
          />
          {!active && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-slate-900/80 rounded"
              data-testid="qr-inactive-overlay"
              aria-hidden="true"
            >
              <span className="text-sm font-bold text-slate-400">{statusLabel}</span>
            </div>
          )}
        </div>

        {/* Info + actions */}
        <div className="flex-1 min-w-0 space-y-2">
          {/* Metadata */}
          <div className="flex flex-wrap gap-2 items-center text-xs">
            <span className={`cf-chip ${invite.role === 'player' ? 'cf-chip-party' : 'cf-chip-private'}`}>
              {roleLabel}
            </span>
            <span className="text-slate-400">{expiryLabel(invite.expiresAt)}</span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400">{remainingLabel(invite)}</span>
            {statusLabel && (
              <span className="text-rose-400 font-semibold">{statusLabel}</span>
            )}
          </div>

          {/* URL fallback (always visible, accessible) */}
          <input
            className="input text-xs w-full"
            readOnly
            value={url}
            aria-label="Invite link URL"
            onFocus={(e) => e.currentTarget.select()}
          />

          {/* Bearer-link warning */}
          <p className="text-[11px] text-amber-400/80 m-0" role="note">
            Bearer link — anyone who scans or copies this can join. Revoke immediately if shared unintentionally.
          </p>

          {error && <p className="text-xs text-rose-400 m-0">{error}</p>}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary text-xs"
              style={{ minHeight: 32 }}
              onClick={handleFullscreen}
              disabled={!active}
              aria-label="Show QR code full screen"
            >
              Full screen
            </button>
            <button
              type="button"
              className="btn btn-secondary text-xs"
              style={{ minHeight: 32 }}
              onClick={handleDownload}
              disabled={!active}
              aria-label="Download QR code as PNG"
            >
              Download
            </button>
            <button
              type="button"
              className="btn btn-secondary text-xs"
              style={{ minHeight: 32 }}
              onClick={handlePrint}
              disabled={!active}
              aria-label="Print QR code"
            >
              Print
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              style={{ minHeight: 32 }}
              onClick={handleCopy}
              aria-label="Copy invite link"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        </div>
      </div>

      {/* Full-screen overlay */}
      {fullscreen && active && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95"
          role="dialog"
          aria-modal="true"
          aria-label="QR code full screen display"
          data-testid="qr-fullscreen"
          onClick={handleExitFullscreen}
        >
          <QrFullscreen url={url} invite={invite} onClose={handleExitFullscreen} />
        </div>
      )}
    </>
  );
}

/**
 * Full-screen QR display with a large canvas. Renders its own canvas at a
 * larger size for optimal scanning from a distance.
 */
function QrFullscreen({
  url,
  invite,
  onClose,
}: {
  url: string;
  invite: CampaignInvite;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    void QRCode.toCanvas(canvas, url, {
      width: 400,
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }, [url]);

  return (
    <div
      className="flex flex-col items-center gap-4 p-6 max-w-md w-full"
      onClick={(e) => e.stopPropagation()}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="QR code for invite link"
        className="rounded-lg"
        width={400}
        height={400}
      />
      <p className="text-white text-sm text-center break-all select-all">{url}</p>
      <p className="text-slate-400 text-xs text-center">
        {invite.role === 'player' ? 'Player' : 'Viewer'} · {expiryLabel(invite.expiresAt)} · {remainingLabel(invite)}
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={onClose}
        aria-label="Exit full screen"
        autoFocus
      >
        Close
      </button>
    </div>
  );
}
