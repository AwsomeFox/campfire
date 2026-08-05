/**
 * Why a DM lifecycle header control is disabled right now (issue #1933) — kept pure so the
 * priority between a safety hold, the sync gate, and each button's own roster/turn-state
 * condition can be pinned in a `.unit.spec.ts` without a browser.
 *
 * Only `start`, `nextTurn`, and `undoTurn` are guarded server-side by `assertNoSafetyHold`
 * (`EncountersService` — issue #599); `end`/`reopen`/`delete`/`rollInitiative` are not, so
 * `safetyHoldActive` is only a resolver input where the server actually rejects the write.
 * `headerBusy` (a request already in flight) intentionally has no reason of its own — every
 * resolver below returns `null` for it, leaving the button plain-disabled as before.
 */

export type LifecycleGateReason =
  | 'safetyHold'
  | 'syncBlocked'
  | 'allInitiativeRolled'
  | 'needsCombatantsToStart'
  | 'needsInitiativeToStart'
  | 'undoNothingToUndo'
  | null;

/** Roll initiative — not safety-hold guarded server-side. */
export function rollInitiativeGateReason(input: {
  riskyBlocked: boolean;
  needsInitiativeCount: number;
}): LifecycleGateReason {
  if (input.riskyBlocked) return 'syncBlocked';
  if (input.needsInitiativeCount === 0) return 'allInitiativeRolled';
  return null;
}

/** Start — safety-hold guarded (`assertNoSafetyHold` in `EncountersService.start`). */
export function startGateReason(input: {
  safetyHoldActive: boolean;
  riskyBlocked: boolean;
  hasNoCombatants: boolean;
  needsInitiativeCount: number;
}): LifecycleGateReason {
  if (input.safetyHoldActive) return 'safetyHold';
  if (input.riskyBlocked) return 'syncBlocked';
  if (input.hasNoCombatants) return 'needsCombatantsToStart';
  if (input.needsInitiativeCount > 0) return 'needsInitiativeToStart';
  return null;
}

/** Undo turn — safety-hold guarded (`EncountersService.undoTurn`). */
export function undoTurnGateReason(input: {
  safetyHoldActive: boolean;
  riskyBlocked: boolean;
  undoTurnDisabled: boolean;
}): LifecycleGateReason {
  if (input.safetyHoldActive) return 'safetyHold';
  if (input.riskyBlocked) return 'syncBlocked';
  if (input.undoTurnDisabled) return 'undoNothingToUndo';
  return null;
}

/** Next turn — safety-hold guarded (`EncountersService.nextTurn`). */
export function nextTurnGateReason(input: {
  safetyHoldActive: boolean;
  riskyBlocked: boolean;
}): LifecycleGateReason {
  if (input.safetyHoldActive) return 'safetyHold';
  if (input.riskyBlocked) return 'syncBlocked';
  return null;
}

/** End / Reopen / Delete — sync-gated only; the server does not check the safety hold for
 * these three (see the module doc comment). */
export function syncOnlyGateReason(riskyBlocked: boolean): LifecycleGateReason {
  return riskyBlocked ? 'syncBlocked' : null;
}
