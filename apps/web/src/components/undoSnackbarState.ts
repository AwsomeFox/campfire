/**
 * Pure reducer for the UndoSnackbar lifecycle (issue #694).
 *
 * The bug this fixes: the Undo bar started an unconditional 7s auto-dismiss
 * timer on mount. On a slow network the bar would vanish — taking the only
 * recovery affordance with it — while a restore was still mid-flight, and a
 * transient restore failure turned an advertised "reversible" delete into an
 * effectively permanent one because no Retry path was retained.
 *
 * Kept pure (no React, no DOM, no `setTimeout`) so the timer-pause + retry
 * behaviour is exhaustively testable in a `.unit.spec.ts` without a browser.
 * The component owns the side-effectful bits: it arms/clears a real timeout,
 * invokes the restore promise, and renders the snapshot.
 *
 * States:
 *   - idle    bar shown with the Undo affordance; the auto-dismiss timer IS
 *             armed (this is the only state that expires on its own)
 *   - pending restore is in flight; the timer is PAUSED so a slow network can't
 *             yank the bar mid-request
 *   - failed  restore rejected; the bar stays open with an error + Retry /
 *             Dismiss (timer stays paused until the user retries or dismisses)
 *   - done    restore succeeded; the component unmounts after announcing
 *
 * The reducer's rule of thumb: `timerArmed` is true ONLY in `idle`. Entering
 * `pending` or `failed` clears it; resolving back to `idle` (on retry from
 * failed) re-arms it with a fresh full window so the user isn't penalised for
 * a flaky network.
 */
export type UndoStatus = 'idle' | 'pending' | 'failed' | 'done';

/** Observable subset of state the component renders + drives the timer from. */
export interface UndoSnapshot {
  status: UndoStatus;
  /** Last error message, surfaced as the "Restore failed — Retry / Dismiss" affordance. */
  error: string | null;
}

export const initialUndoState: UndoSnapshot = {
  status: 'idle',
  error: null,
};

/** Default label for a restore failure (callers may override via `failed`). */
export const DEFAULT_UNDO_ERROR = 'Restore failed. Try again or dismiss.';

/** Events the component dispatches. */
export type UndoEvent =
  | { type: 'undo' }
  | { type: 'succeeded' }
  | { type: 'failed'; error?: string }
  | { type: 'retry' };

/**
 * Whether the auto-dismiss timer should be armed for the given snapshot.
 *
 * The core fix for issue #694: the bar only expires on its own while it is
 * showing the Undo affordance. The moment a restore starts (`pending`) or fails
 * (`failed`), the timer is disarmed so the recovery path stays available.
 */
export function timerArmed(snapshot: UndoSnapshot): boolean {
  return snapshot.status === 'idle';
}

/**
 * Reduce a snapshot by an event. Pure: no side effects, no clock.
 *
 * `undo`/`retry` both transition to `pending` (clearing any prior error); the
 * component treats them identically — `retry` only exists to make the failure
 * → retry intent explicit in tests and at the call site.
 */
export function reduceUndo(
  state: UndoSnapshot,
  event: UndoEvent,
): UndoSnapshot {
  switch (event.type) {
    case 'undo':
    case 'retry':
      // Starting (or re-starting) a restore: clear the error and pause the
      // timer by leaving the idle state.
      return { status: 'pending', error: null };
    case 'succeeded':
      return { status: 'done', error: null };
    case 'failed':
      return { status: 'failed', error: event.error ?? DEFAULT_UNDO_ERROR };
    default: {
      // Exhaustiveness guard — a new event must be handled explicitly.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Guard for the duplicate-restore protection (issue #694). The Undo button is
 * a no-op while a restore is already in flight, so spamming Undo never fires a
 * second POST. `failed` is intentionally NOT a busy state: Retry must work.
 */
export function isBusy(snapshot: UndoSnapshot): boolean {
  return snapshot.status === 'pending';
}

/**
 * Whether the snackbar should remain mounted. `done` is the only terminal
 * state; the component unmounts (and announces success) once it is reached.
 */
export function isOpen(snapshot: UndoSnapshot): boolean {
  return snapshot.status !== 'done';
}
