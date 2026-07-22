import { expect, test } from '@playwright/test';
import {
  DEFAULT_UNDO_ERROR,
  initialUndoState,
  isBusy,
  isOpen,
  reduceUndo,
  timerArmed,
  type UndoSnapshot,
} from '../../src/components/undoSnackbarState';

/**
 * Issue #694 — the Undo snackbar must keep the restore recovery path available
 * while a restore is pending and after one fails.
 *
 * The timer-pause + retry behaviour lives in a pure reducer
 * (`undoSnackbarState.ts`) so it can be exercised exhaustively here without a
 * browser. These specs pin the acceptance scenarios:
 *   (a) the auto-dismiss timer pauses while a restore is pending,
 *   (b) a failed restore retains the bar with a Retry path,
 *   (c) a duplicate Undo while pending is a no-op (guard),
 *   (d) a successful restore closes the bar.
 *
 * The component's only job is to arm/clear a real timeout from `timerArmed`,
 * invoke the restore promise, and render the snapshot.
 */
function from(partial: Partial<UndoSnapshot>): UndoSnapshot {
  return { ...initialUndoState, ...partial };
}

test.describe('undo snackbar lifecycle (issue #694)', () => {
  test('idle arms the auto-dismiss timer', () => {
    expect(timerArmed(initialUndoState)).toBe(true);
    expect(isOpen(initialUndoState)).toBe(true);
    expect(isBusy(initialUndoState)).toBe(false);
  });

  test('undo pauses the timer while the restore is pending (slow-network path)', () => {
    const pending = reduceUndo(initialUndoState, { type: 'undo' });
    expect(pending).toMatchObject({ status: 'pending', error: null });
    // The core fix: the timer is DISARMED the moment a restore starts, so a
    // slow network can't remove the only recovery affordance mid-request.
    expect(timerArmed(pending)).toBe(false);
    expect(isBusy(pending)).toBe(true);
    expect(isOpen(pending)).toBe(true);
  });

  test('a duplicate undo while pending is a no-op (duplicate-restore guard)', () => {
    const pending = reduceUndo(initialUndoState, { type: 'undo' });
    // Re-dispatching undo from `pending` is idempotent: still pending, still
    // disarmed. The component additionally short-circuits the click so no
    // second restore POST fires; this spec pins the state half of that guard.
    const still = reduceUndo(pending, { type: 'undo' });
    expect(still).toEqual(pending);
    expect(timerArmed(still)).toBe(false);
    expect(isBusy(still)).toBe(true);
  });

  test('a failed restore retains the bar with a Retry path and keeps the timer paused', () => {
    const pending = reduceUndo(initialUndoState, { type: 'undo' });
    const failed = reduceUndo(pending, { type: 'failed', error: 'network reset' });
    expect(failed).toMatchObject({ status: 'failed', error: 'network reset' });
    // The bar stays open (so Retry/Dismiss are reachable)…
    expect(isOpen(failed)).toBe(true);
    // …and is NOT busy, so the Retry button is enabled.
    expect(isBusy(failed)).toBe(false);
    // …and the timer stays paused: a failure must not auto-dismiss the recovery.
    expect(timerArmed(failed)).toBe(false);
  });

  test('a failed restore without an explicit error uses the default message', () => {
    const pending = reduceUndo(initialUndoState, { type: 'undo' });
    const failed = reduceUndo(pending, { type: 'failed' });
    expect(failed.error).toBe(DEFAULT_UNDO_ERROR);
  });

  test('retry re-enters pending from failed and clears the error (retried path)', () => {
    const pending = reduceUndo(initialUndoState, { type: 'undo' });
    const failed = reduceUndo(pending, { type: 'failed', error: 'boom' });
    const retried = reduceUndo(failed, { type: 'retry' });
    expect(retried).toMatchObject({ status: 'pending', error: null });
    expect(isBusy(retried)).toBe(true);
    // Timer is paused again for the retry attempt.
    expect(timerArmed(retried)).toBe(false);
  });

  test('a successful restore closes the bar (success path)', () => {
    const pending = reduceUndo(initialUndoState, { type: 'undo' });
    const done = reduceUndo(pending, { type: 'succeeded' });
    expect(done).toMatchObject({ status: 'done', error: null });
    // `done` is the only terminal state — the component unmounts.
    expect(isOpen(done)).toBe(false);
    expect(timerArmed(done)).toBe(false);
  });

  test('the full interrupted path: undo -> failed -> retry -> succeeded closes the bar', () => {
    let snap: UndoSnapshot = initialUndoState;
    expect(timerArmed(snap)).toBe(true);
    snap = reduceUndo(snap, { type: 'undo' });
    expect(timerArmed(snap)).toBe(false);
    snap = reduceUndo(snap, { type: 'failed', error: 'offline' });
    expect(isOpen(snap)).toBe(true);
    expect(isBusy(snap)).toBe(false);
    snap = reduceUndo(snap, { type: 'retry' });
    expect(timerArmed(snap)).toBe(false);
    snap = reduceUndo(snap, { type: 'succeeded' });
    expect(isOpen(snap)).toBe(false);
  });

  test('the slow-then-success path: undo (timer paused) -> succeeded closes the bar without the timer ever re-arming', () => {
    let snap: UndoSnapshot = initialUndoState;
    snap = reduceUndo(snap, { type: 'undo' });
    // While pending the timer is paused indefinitely — a long restore never
    // auto-dismisses. Success then closes the bar.
    expect(timerArmed(snap)).toBe(false);
    snap = reduceUndo(snap, { type: 'succeeded' });
    expect(isOpen(snap)).toBe(false);
    expect(timerArmed(snap)).toBe(false);
  });

  test('a failed bar can be retried more than once without ever re-arming the timer', () => {
    let snap: UndoSnapshot = from({ status: 'failed', error: 'flaky' });
    for (let i = 0; i < 3; i++) {
      snap = reduceUndo(snap, { type: 'retry' });
      expect(timerArmed(snap)).toBe(false);
      snap = reduceUndo(snap, { type: 'failed', error: `flaky-${i}` });
      expect(timerArmed(snap)).toBe(false);
      expect(isOpen(snap)).toBe(true);
    }
  });
});
