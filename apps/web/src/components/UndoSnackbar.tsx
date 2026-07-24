/**
 * UndoSnackbar (issues #116, #694, #794) — the transient "X deleted — Undo"
 * affordance shown after a soft-delete. Deletes are reversible server-side
 * (every trashable entity has a `deleted_at` + a restore endpoint), so a
 * mis-click is recoverable: this bar gives an immediate one-click Undo (which
 * POSTs the restore endpoint) before the user leaves the page.
 *
 * Issue #694 — keep the recovery path available while a restore is pending and
 * after one fails:
 *   - The auto-dismiss timer is PAUSED while a restore is in flight, so a slow
 *     network can't remove the only undo affordance mid-request.
 *   - On failure the bar stays open in an error state with Retry / Dismiss
 *     instead of disappearing with the restore still broken.
 *   - Spamming Undo while a restore is pending is a no-op (duplicate guard).
 *   - Pending / failure are announced via the snackbar's own aria-live region;
 *     success is announced via the app-root Announcer (`successMessage`),
 *     which survives the parent unmounting this bar during `onUndo`.
 *   - The auto-dismiss timer is cancelled synchronously inside `undo()`, so a
 *     timeout firing at the click boundary can't race the pending-state clear.
 *
 * Issue #794 — clear the mobile tab bar, safe-area, and on-screen keyboard:
 *   - Bottom offset is measured tab-bar content + safe-area + keyboard inset
 *     (see `undoSnackbarLayout.ts` / `useUndoSnackbarChrome`).
 *   - Stacking uses `--cf-layer-snackbar` so the bar sits above the tab bar and
 *     coordinates with dialog / notification layers.
 *   - Narrow viewports wrap; Undo / Dismiss keep 44×44 hit targets.
 *
 * The lifecycle lives in `undoSnackbarState.ts` (pure, tested without a
 * browser); this component owns the side-effectful bits — the real timeout, the
 * restore promise, chrome measurement, and the render.
 */
import { useEffect, useRef, useState } from 'react';
import { useAnnounce } from './Announcer';
import {
  initialUndoState,
  isOpen,
  isBusy,
  reduceUndo,
  timerArmed,
  type UndoSnapshot,
} from './undoSnackbarState';
import { useUndoSnackbarChrome } from './useUndoSnackbarChrome';

export function UndoSnackbar({
  message,
  onUndo,
  onExpire,
  timeoutMs = 7000,
  successMessage = 'Restored.',
}: {
  message: string;
  /** Restore the entity. Return a promise so the bar can show a "Restoring…" state. */
  onUndo: () => Promise<void>;
  /** Fired when the window closes without an undo (auto-dismiss or explicit dismiss). */
  onExpire: () => void;
  timeoutMs?: number;
  /**
   * Message spoken to assistive tech after a successful restore. Announced via
   * the app-root live region (Announcer) so it is still heard when the parent
   * unmounts this snackbar during `onUndo` (every current caller does).
   */
  successMessage?: string;
}) {
  const [snapshot, setSnapshot] = useState<UndoSnapshot>(initialUndoState);
  // App-root live region (mounted once in AnnounceProvider, see Announcer.tsx).
  // Durable: survives this snackbar being unmounted by its parent mid-`undo`.
  const announce = useAnnounce();
  // Publish --cf-tabbar-content-height / --cf-keyboard-inset while mounted so
  // `.cf-undo-snackbar` clears the tab bar, safe-area, and virtual keyboard.
  useUndoSnackbarChrome();

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

  async function undo() {
    // Duplicate-restore guard: a restore is already in flight — ignore the
    // extra click. (`failed` is NOT busy, so Retry still works.)
    if (isBusy(snapshot)) return;
    // Cancel the auto-dismiss timer SYNCHRONOUSLY, before awaiting the restore.
    // Relying on the timer effect below to clear it after the `pending` state
    // commits is racy at the timeout boundary: the pending timeout could fire
    // (calling onExpire → parent unmount) between the click and the effect
    // cleanup. Clearing the ref here guarantees the in-flight timeout is gone
    // the moment the user commits to a restore.
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // The UI labels the action "Retry" in the failed state; dispatch the
    // matching `'retry'` event so the intent is explicit and the reducer's
    // `'retry'` branch isn't dead code. From `idle` this is a first attempt,
    // so it stays `'undo'`. (Both events transition to `pending` identically.)
    const startEvent =
      snapshot.status === 'failed' ? { type: 'retry' as const } : { type: 'undo' as const };
    setSnapshot((cur) => reduceUndo(cur, startEvent));
    try {
      await onUndoRef.current();
      // Announce success via the app-root live region BEFORE the parent unmounts
      // this snackbar. Every current caller (QuestPage, NpcPage, LocationPage,
      // SessionsPage, MyNotesPage) clears its pending-undo state inside `onUndo`
      // once the restore POST resolves, so this component unmounts before a
      // screen reader would read its own role="status". The Announcer's polite
      // region lives at the app root and survives that unmount.
      announce(successMessage);
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
      data-testid="undo-snackbar"
      className={failed ? 'cf-undo-snackbar cf-undo-snackbar--failed' : 'cf-undo-snackbar'}
    >
      {/* The visible message is ALWAYS aria-hidden: with role="status" +
          aria-atomic="true" the live region would otherwise concatenate it
          with the sr-only announcement, producing duplicate reads in the
          idle/pending states. The sr-only span below is the single
          announcement source. */}
      <span className="cf-undo-snackbar__message" aria-hidden>
        {error ?? message}
      </span>
      <span className="sr-only">{announcement}</span>
      <div className="cf-undo-snackbar__actions">
        <button
          type="button"
          className="btn btn-secondary cf-undo-snackbar__action"
          onClick={() => void undo()}
          disabled={busy}
        >
          {actionLabel}
        </button>
        <button
          type="button"
          className="cf-undo-snackbar__dismiss"
          aria-label="Dismiss"
          onClick={() => onExpire()}
          disabled={busy}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
