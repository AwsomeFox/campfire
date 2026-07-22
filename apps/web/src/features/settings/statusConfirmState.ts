/**
 * Pure reducer for the campaign status confirmation + undo lifecycle (issue #640).
 *
 * The bug this fixes: `StatusCard` applied Paused/Completed the instant the DM
 * picked them from the select, making the whole campaign read-only with no
 * chance to back out. Issue #640's audit calls for a pending selection, a
 * consequence-rich confirmation, a current→proposed preview, an active-client
 * announcement, and a safe undo — none of which a fire-on-change select can
 * provide.
 *
 * Kept pure (no React, no DOM, no network) so the preview/confirm/undo state
 * machine is exhaustively testable in a `.unit.spec.ts` without a browser. The
 * `StatusCard` component owns the side-effectful bits: it renders the select +
 * preview, opens the ConfirmDialog, PATCHes the campaign, and arms the real
 * undo timeout from `undoArmed`.
 *
 * Phases:
 *   - idle        nothing pending; the select reflects the persisted status
 *   - preview     the DM picked a new status from the select; a preview card
 *                 shows the current→proposed change and an Apply affordance.
 *                 Cancel returns to idle without touching the server.
 *   - confirming  the DM clicked Apply on an archiving change; the
 *                 ConfirmDialog is open spelling out the consequence. Confirm
 *                 commits (→ undo); Cancel returns to preview (NOT idle) so the
 *                 DM can re-read the preview or pick a different status without
 *                 re-selecting.
 *   - undo        the PATCH committed; an UndoSnackbar is shown for a short
 *                 window so a mis-click can be reversed before the read-only
 *                 lock sets in psychologically. `expire` (auto-dismiss or
 *                 explicit dismiss) returns to idle.
 *
 * The reducer NEVER transitions preview/confirming → applied directly: `applied`
 * always passes through `undo` first, so the recovery affordance is guaranteed
 * to be armed the moment a destructive change lands. `reset` (campaign reloaded
 * or an external status change) clears every pending transient.
 */
export type CampaignStatus = 'active' | 'paused' | 'completed';

export type StatusConfirmPhase = 'idle' | 'preview' | 'confirming' | 'undo';

export interface StatusConfirmSnapshot {
  phase: StatusConfirmPhase;
  /** The status the DM has picked from the select but not yet applied. Null in idle/undo. */
  pending: CampaignStatus | null;
  /**
   * The status that was persisted immediately before the last applied PATCH.
   * Captured so the Undo affordance can revert to it. Null unless phase === 'undo'.
   */
  appliedFrom: CampaignStatus | null;
}

export const initialStatusConfirmState: StatusConfirmSnapshot = {
  phase: 'idle',
  pending: null,
  appliedFrom: null,
};

/** Events the component dispatches. */
export type StatusConfirmEvent =
  /** The DM picked `status` from the select. No-op if it matches the current status. */
  | { type: 'select'; status: CampaignStatus; current: CampaignStatus }
  /** Dismiss the preview card without applying. */
  | { type: 'cancel' }
  /**
   * The DM clicked Apply on an archiving change — open the ConfirmDialog.
   * Only meaningful from `preview`; idempotent otherwise so a stray double-
   * click never arms a phantom confirm.
   */
  | { type: 'requestConfirm' }
  /**
   * Cancel from the ConfirmDialog — return to `preview` (NOT idle) so the DM
   * can re-read the preview or pick a different status without re-selecting.
   */
  | { type: 'cancelConfirm' }
  /**
   * The PATCH committed with `from` as the prior persisted status. Arms the
   * undo window: the snackbar is the only recovery path, so it must be armed
   * the instant the change lands.
   */
  | { type: 'applied'; from: CampaignStatus }
  /** Undo window elapsed (auto-dismiss) or the DM dismissed the snackbar. */
  | { type: 'expire' }
  /** Campaign was reloaded or an external actor changed the status — drop all transients. */
  | { type: 'reset' };

/**
 * Whether the undo snackbar should be mounted. True only in `undo` — the one
 * phase with a recovery affordance. The component arms/clears its real timeout
 * from this flag the same way `UndoSnackbar` does from `timerArmed`.
 */
export function undoArmed(snapshot: StatusConfirmSnapshot): boolean {
  return snapshot.phase === 'undo';
}

/**
 * Whether the ConfirmDialog should be mounted. True only in `confirming` — the
 * DM clicked Apply on an archiving change and must confirm before the PATCH.
 * The component renders the dialog solely from this flag so a select that arms
 * a preview does NOT immediately open the modal (the #640 mis-click window).
 */
export function confirmOpen(snapshot: StatusConfirmSnapshot): boolean {
  return snapshot.phase === 'confirming';
}

/**
 * Reduce a snapshot by an event. Pure: no side effects, no clock, no network.
 *
 * Transitions:
 *   select         → preview (unless the pick matches `current`, → idle)
 *   requestConfirm → confirming (only from preview; idempotent otherwise)
 *   cancelConfirm  → preview (NOT idle, so the DM keeps the pending pick)
 *   cancel         → idle
 *   applied        → undo (always; never idle — the snackbar must arm on commit)
 *   expire         → idle
 *   reset          → idle
 */
export function reduceStatusConfirm(
  state: StatusConfirmSnapshot,
  event: StatusConfirmEvent,
): StatusConfirmSnapshot {
  switch (event.type) {
    case 'select': {
      // Picking the already-persisted status is a no-op: collapse to idle so a
      // stray select→same-value interaction never arms a phantom preview.
      if (event.status === event.current) {
        return { phase: 'idle', pending: null, appliedFrom: null };
      }
      return { phase: 'preview', pending: event.status, appliedFrom: null };
    }
    case 'requestConfirm': {
      // Only arm the confirm from preview — a stray requestConfirm from idle
      // (no pending pick to confirm) or undo (already committed) is a no-op.
      if (state.phase !== 'preview' || !state.pending) return state;
      return { phase: 'confirming', pending: state.pending, appliedFrom: null };
    }
    case 'cancelConfirm': {
      // Return to preview (NOT idle) so the DM can re-read the preview or pick
      // a different status without re-selecting from scratch. Idempotent if
      // somehow dispatched from a non-confirming phase.
      if (state.phase !== 'confirming' || !state.pending) return state;
      return { phase: 'preview', pending: state.pending, appliedFrom: null };
    }
    case 'cancel':
      return { phase: 'idle', pending: null, appliedFrom: null };
    case 'applied':
      // Always transition to undo — never straight back to idle — so the
      // recovery affordance is armed the instant a destructive change commits.
      return { phase: 'undo', pending: null, appliedFrom: event.from };
    case 'expire':
      return { phase: 'idle', pending: null, appliedFrom: null };
    case 'reset':
      return { phase: 'idle', pending: null, appliedFrom: null };
    default: {
      // Exhaustiveness guard — a new event must be handled explicitly.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * Whether a transition from `from` to `to` makes the campaign read-only (and so
 * warrants the consequence-rich confirmation + undo). The safe direction — any
 * status back to Active — is reversible by definition and skips the heavy gate.
 *
 * Used by the component to decide whether the Apply button opens a ConfirmDialog
 * (archiving) or PATCHes directly (un-archiving), and by tests to pin the rule.
 */
export function isArchivingTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  // Active → Active is not a transition at all; treat it as non-archiving so
  // the preview card never renders a phantom confirmation for a no-op.
  if (from === to) return false;
  // Anything → Active is the recovery direction; never archives.
  if (to === 'active') return false;
  // Paused ↔ Completed keeps the campaign read-only; still archive-tier.
  return true;
}
