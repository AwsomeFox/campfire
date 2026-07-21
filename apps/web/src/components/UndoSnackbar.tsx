/**
 * UndoSnackbar (issue #116) — the transient "X deleted — Undo" affordance shown after a
 * soft-delete. Deletes are now reversible server-side (every trashable entity has a
 * `deleted_at` + a restore endpoint), so a mis-click is recoverable: this bar gives an
 * immediate one-click Undo (which POSTs the restore endpoint) before the user leaves the
 * page. If they don't act within `timeoutMs`, `onExpire` fires (typically: navigate away
 * from the now-deleted entity). Self-contained, theme-aware, and keyboard-reachable.
 */
import { useEffect, useRef, useState } from 'react';

export function UndoSnackbar({
  message,
  onUndo,
  onExpire,
  timeoutMs = 7000,
}: {
  message: string;
  /** Restore the entity. Return a promise so the bar can show a "Restoring…" state. */
  onUndo: () => Promise<void>;
  /** Fired when the window closes without an undo (auto-dismiss). */
  onExpire: () => void;
  timeoutMs?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const id = setTimeout(() => onExpireRef.current(), timeoutMs);
    return () => clearTimeout(id);
  }, [timeoutMs]);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      await onUndo();
    } catch {
      setError('Restore failed');
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        maxWidth: 'calc(100vw - 32px)',
        padding: '10px 12px 10px 16px',
        borderRadius: 'var(--radius-md, 10px)',
        background: 'var(--color-neutral-800, #1c1c22)',
        color: 'var(--color-neutral-100, #f2f2f5)',
        border: '1px solid var(--color-neutral-700, #333)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
        fontSize: 13,
      }}
    >
      <span>{error ?? message}</span>
      <button
        className="btn btn-secondary"
        style={{ fontSize: 12.5, minHeight: 0, padding: '4px 12px' }}
        onClick={() => void undo()}
        disabled={busy}
      >
        {busy ? 'Restoring…' : 'Undo'}
      </button>
      <button
        aria-label="Dismiss"
        onClick={() => onExpire()}
        disabled={busy}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--color-neutral-400, #999)',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          padding: '2px 4px',
        }}
      >
        ✕
      </button>
    </div>
  );
}
