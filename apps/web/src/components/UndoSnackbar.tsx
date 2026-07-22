/**
 * UndoSnackbar (issues #116, #694) — the transient "X deleted — Undo" affordance
 * shown after a soft-delete. Deletes are reversible server-side (every trashable
 * entity has a `deleted_at` + a restore endpoint), so a mis-click is recoverable:
 * this bar gives an immediate one-click Undo (which POSTs the restore endpoint)
 * before the user leaves the page.
 *
 * Issue #694 — keep the recovery path available while a restore is pending and
 * after one fails:
 *   - The auto-dismiss timer is PAUSED while a restore is in flight, so a slow
 *     network can't remove the only undo affordance mid-request.
 *   - On failure the bar stays open in an error state with Retry / Dismiss
 *     instead of disappearing with the restore still broken.
 *   - Spamming Undo while a restore is pending is a no-op (duplicate guard).
 *   - Pending / success / failure are announced via an aria-live region.
 *
 * The lifecycle lives in `undoSnackbarState.ts` (pure, tested without a
 * browser); this component owns the side-effectful bits — the real timeout, the
 * restore promise, and the render.
 */
import { useEffect, useRef, useState } from 'react';
import {
  initialUndoState,
  isOpen,
  isBusy,
  reduceUndo,
  timerArmed,
  type UndoSnapshot,
} from './undoSnackbarState';

export function UndoSnackbar({
  message,
  onUndo,
  onExpire,
  timeoutMs = 7000,
}: {
  message: string;
  /** Restore the entity. Return a promise so the bar can show a "Restoring…" state. */
  onUndo: () => Promise<void>;
  /** Fired when the window closes without an undo (auto-dismiss or explicit dismiss). */
  onExpire: () => void;
  timeoutMs?: number;
}) {
  const [snapshot, setSnapshot] = useState<UndoSnapshot>(initialUndoState);

  // Unmount guard: the restore promise in `undo()` resolves asynchronously, so
  // the bar's parent may have unmounted it (e.g. cleared `pendingUndo`) while
  // the request was still in flight. Guarded state updates follow the same
  // `mountedRef` pattern as NotificationsBell.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The timeout is held in a ref so its arming/clearing is driven entirely by
  // the snapshot's `timerArmed` flag (idle arms it; pending/failed clear it).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest callbacks so the effect that arms the timer never goes stale without
  // re-arming on every render (which would reset the window constantly).
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const onUndoRef = useRef(onUndo);
  onUndoRef.current = onUndo;

  // Arm/clear the auto-dismiss timer solely from the snapshot. `timerArmed` is
  // true only in `idle`, so entering `pending` or `failed` clears the timer and
  // it is NOT restarted until the bar returns to `idle` (i.e. never, while the
  // user holds the Retry/Dismiss decision). On success the component unmounts.
  useEffect(() => {
    if (!timerArmed(snapshot)) {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setTimeout(() => onExpireRef.current(), timeoutMs);
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [snapshot, timeoutMs]);

  // Unmount safety: never leak a pending timer if the bar is removed by its
  // parent (e.g. the caller cleared `pendingUndo` directly).
  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  // On success, announce + close. Done in an effect (not inline in `undo`) so
  // the snapshot remains the single source of truth and the render reflects the
  // `done` state for a frame before the parent unmounts the bar.
  useEffect(() => {
    if (snapshot.status === 'done') {
      onExpireRef.current();
    }
  }, [snapshot.status]);

  async function undo() {
    // Duplicate-restore guard: a restore is already in flight — ignore the
    // extra click. (`failed` is NOT busy, so Retry still works.)
    if (isBusy(snapshot)) return;
    // The UI labels the action "Retry" in the failed state; dispatch the
    // matching `'retry'` event so the intent is explicit and the reducer's
    // `'retry'` branch isn't dead code. From `idle` this is a first attempt,
    // so it stays `'undo'`. (Both events transition to `pending` identically.)
    const startEvent =
      snapshot.status === 'failed' ? { type: 'retry' as const } : { type: 'undo' as const };
    setSnapshot((cur) => reduceUndo(cur, startEvent));
    try {
      await onUndoRef.current();
      if (mountedRef.current) {
        setSnapshot((cur) => reduceUndo(cur, { type: 'succeeded' }));
      }
    } catch {
      if (mountedRef.current) {
        setSnapshot((cur) =>
          reduceUndo(cur, { type: 'failed' }),
        );
      }
    }
  }

  if (!isOpen(snapshot)) return null;

  const busy = isBusy(snapshot);
  const failed = snapshot.status === 'failed';
  const error = snapshot.error;

  // Status message for the visually-hidden live region. Each branch is a fresh
  // string so a screen reader announces the transition (polite: this is a
  // recoverable, non-interrupting affordance).
  const announcement = busy
    ? 'Restoring…'
    : failed
      ? (error ?? 'Restore failed')
      : message;

  const actionLabel = busy ? 'Restoring…' : failed ? 'Retry' : 'Undo';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
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
        border: failed
          ? '1px solid var(--color-danger-500, #d33)'
          : '1px solid var(--color-neutral-700, #333)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
        fontSize: 13,
      }}
    >
      {/* The visible message is ALWAYS aria-hidden: with role="status" +
          aria-atomic="true" the live region would otherwise concatenate it
          with the sr-only announcement, producing duplicate reads in the
          idle/pending states. The sr-only span below is the single
          announcement source. */}
      <span aria-hidden>{error ?? message}</span>
      <span className="sr-only">{announcement}</span>
      <button
        className="btn btn-secondary"
        style={{ fontSize: 12.5, minHeight: 0, padding: '4px 12px' }}
        onClick={() => void undo()}
        disabled={busy}
      >
        {actionLabel}
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
