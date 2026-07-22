import { expect, test } from '@playwright/test';
import {
  confirmOpen,
  initialStatusConfirmState,
  isArchivingTransition,
  reduceStatusConfirm,
  undoArmed,
  type CampaignStatus,
  type StatusConfirmSnapshot,
} from '../../src/features/settings/statusConfirmState';

/**
 * Issue #640 — the campaign status select applied Paused/Completed the instant
 * the DM picked them, locking the whole campaign read-only with no chance to
 * back out. The fix is a pending-selection → preview → confirm → undo state
 * machine that lives in a pure reducer (`statusConfirmState.ts`) so it can be
 * exercised exhaustively here without a browser.
 *
 * These specs pin the acceptance scenarios:
 *   (a) selecting the same status is a no-op (no phantom preview),
 *   (b) selecting a different status arms the preview with the pick pending,
 *   (c) requestConfirm (Apply click on an archiving change) arms the modal,
 *       but ONLY from preview — a select never opens the modal directly,
 *   (d) cancelConfirm returns to preview (NOT idle) so the DM keeps the pick,
 *   (e) cancel from the preview returns to idle without touching the server,
 *   (f) applied ALWAYS arms the undo window (never idle straight through),
 *   (g) expire/dismiss returns to idle,
 *   (h) reset drops every transient on a reload/external change,
 *   (i) only archiving directions (Active → Paused/Completed, and the
 *       Paused ↔ Completed reshuffle) count as archive-tier — anything → Active
 *       is the recovery direction and skips the heavy gate.
 */
function from(partial: Partial<StatusConfirmSnapshot>): StatusConfirmSnapshot {
  return { ...initialStatusConfirmState, ...partial };
}

const previewPaused = reduceStatusConfirm(initialStatusConfirmState, {
  type: 'select',
  status: 'paused',
  current: 'active',
});

test.describe('campaign status confirmation lifecycle (issue #640)', () => {
  test('idle is the clean baseline', () => {
    expect(initialStatusConfirmState).toMatchObject({ phase: 'idle', pending: null, appliedFrom: null });
    expect(undoArmed(initialStatusConfirmState)).toBe(false);
    expect(confirmOpen(initialStatusConfirmState)).toBe(false);
  });

  test('selecting the same status is a no-op (no phantom preview)', () => {
    const next = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'select',
      status: 'active',
      current: 'active',
    });
    expect(next).toEqual(initialStatusConfirmState);
  });

  test('selecting a different status arms the preview with the pick pending', () => {
    expect(previewPaused).toMatchObject({ phase: 'preview', pending: 'paused', appliedFrom: null });
    // Preview is NOT a confirm or an undo window.
    expect(confirmOpen(previewPaused)).toBe(false);
    expect(undoArmed(previewPaused)).toBe(false);
  });

  test('requestConfirm (Apply click) arms the modal ONLY from preview', () => {
    // From preview → confirming.
    const confirming = reduceStatusConfirm(previewPaused, { type: 'requestConfirm' });
    expect(confirming).toMatchObject({ phase: 'confirming', pending: 'paused', appliedFrom: null });
    expect(confirmOpen(confirming)).toBe(true);
    // The undo window is NOT armed at confirm time — only after the PATCH.
    expect(undoArmed(confirming)).toBe(false);

    // requestConfirm from idle is a no-op (no pending pick to confirm).
    const fromIdle = reduceStatusConfirm(initialStatusConfirmState, { type: 'requestConfirm' });
    expect(fromIdle).toEqual(initialStatusConfirmState);

    // requestConfirm from undo (already committed) is a no-op.
    const undo = reduceStatusConfirm(initialStatusConfirmState, { type: 'applied', from: 'active' });
    expect(reduceStatusConfirm(undo, { type: 'requestConfirm' })).toEqual(undo);
  });

  test('cancelConfirm returns to preview (NOT idle) so the DM keeps the pick', () => {
    const confirming = reduceStatusConfirm(previewPaused, { type: 'requestConfirm' });
    const backToPreview = reduceStatusConfirm(confirming, { type: 'cancelConfirm' });
    expect(backToPreview).toMatchObject({ phase: 'preview', pending: 'paused', appliedFrom: null });
    expect(confirmOpen(backToPreview)).toBe(false);
    // The pending pick survives — the DM doesn't have to re-select.
    expect(backToPreview.pending).toBe('paused');

    // cancelConfirm from a non-confirming phase is a no-op.
    expect(reduceStatusConfirm(previewPaused, { type: 'cancelConfirm' })).toEqual(previewPaused);
  });

  test('cancel from the preview returns to idle without touching the server', () => {
    const previewCompleted = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'select',
      status: 'completed',
      current: 'active',
    });
    const cancelled = reduceStatusConfirm(previewCompleted, { type: 'cancel' });
    expect(cancelled).toEqual(initialStatusConfirmState);
  });

  test('applied ALWAYS arms the undo window — never straight to idle', () => {
    // The core #640 guarantee: the recovery affordance is armed the instant a
    // destructive change commits. `applied` must not short-circuit to idle.
    const applied = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'applied',
      from: 'active',
    });
    expect(applied).toMatchObject({ phase: 'undo', pending: null, appliedFrom: 'active' });
    expect(undoArmed(applied)).toBe(true);

    // Even from confirming, applied lands in undo (not back at preview/idle).
    const confirming = reduceStatusConfirm(previewPaused, { type: 'requestConfirm' });
    const appliedFromConfirming = reduceStatusConfirm(confirming, { type: 'applied', from: 'active' });
    expect(undoArmed(appliedFromConfirming)).toBe(true);
    expect(appliedFromConfirming.appliedFrom).toBe('active');
  });

  test('expire/dismiss returns to idle and drops the captured prior status', () => {
    const applied = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'applied',
      from: 'active',
    });
    const expired = reduceStatusConfirm(applied, { type: 'expire' });
    expect(expired).toEqual(initialStatusConfirmState);
    expect(undoArmed(expired)).toBe(false);
  });

  test('reset drops every transient on a reload or external status change', () => {
    const preview = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'select',
      status: 'completed',
      current: 'active',
    });
    expect(reduceStatusConfirm(preview, { type: 'reset' })).toEqual(initialStatusConfirmState);

    const confirming = reduceStatusConfirm(preview, { type: 'requestConfirm' });
    expect(reduceStatusConfirm(confirming, { type: 'reset' })).toEqual(initialStatusConfirmState);

    const applied = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'applied',
      from: 'active',
    });
    expect(reduceStatusConfirm(applied, { type: 'reset' })).toEqual(initialStatusConfirmState);
  });

  test('undo captures the prior status so the revert target survives', () => {
    // active → completed → undo should know to revert to 'active'.
    const applied = reduceStatusConfirm(initialStatusConfirmState, {
      type: 'applied',
      from: 'active',
    });
    expect(applied.appliedFrom).toBe('active');

    // A second applied (e.g. paused → completed reshuffle) captures 'paused'.
    const fromPaused: StatusConfirmSnapshot = from({ phase: 'idle' });
    const reshuffled = reduceStatusConfirm(fromPaused, {
      type: 'applied',
      from: 'paused',
    });
    expect(reshuffled.appliedFrom).toBe('paused');
  });
});

test.describe('isArchivingTransition — which directions warrant the heavy gate', () => {
  const cases: Array<{ from: CampaignStatus; to: CampaignStatus; expected: boolean; why: string }> = [
    { from: 'active', to: 'paused', expected: true, why: 'locks the campaign read-only' },
    { from: 'active', to: 'completed', expected: true, why: 'locks the campaign read-only' },
    { from: 'paused', to: 'completed', expected: true, why: 'stays read-only; archive-tier reshuffle' },
    { from: 'completed', to: 'paused', expected: true, why: 'stays read-only; archive-tier reshuffle' },
    { from: 'paused', to: 'active', expected: false, why: 'recovery direction — the edit IS the undo' },
    { from: 'completed', to: 'active', expected: false, why: 'recovery direction — the edit IS the undo' },
    { from: 'active', to: 'active', expected: false, why: 'no-op — never arms a phantom confirmation' },
  ];

  for (const { from, to, expected, why } of cases) {
    test(`${from} → ${to} is${expected ? '' : ' not'} archiving (${why})`, () => {
      expect(isArchivingTransition(from, to)).toBe(expected);
    });
  }
});
