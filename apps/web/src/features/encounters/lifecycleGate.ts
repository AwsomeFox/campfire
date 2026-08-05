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

/**
 * The STANDING roster setup step, independent of the transient gates.
 *
 * `startGateReason` below answers "why is Start disabled right now", which is a priority
 * question — a safety hold or a sync outage outranks the roster because those are what the
 * server would reject on first. But the roster condition is a different kind of statement:
 * a permanently-displayed "here is the setup step you still owe" instruction, which stays
 * true (and stays the DM's next action) throughout an outage or a hold. Deriving the
 * paragraph from the single winning gate key made it vanish exactly when a DM with an empty
 * roster had a greyed-out Start and no visible explanation at all (issue #1933 review).
 *
 * Returns only the two roster keys, never `safetyHold`/`syncBlocked` — those are transient
 * and belong in the tooltip, not in a standing paragraph.
 */
export function startRosterHintReason(input: {
  hasNoCombatants: boolean;
  needsInitiativeCount: number;
}): Extract<LifecycleGateReason, 'needsCombatantsToStart' | 'needsInitiativeToStart'> | null {
  if (input.hasNoCombatants) return 'needsCombatantsToStart';
  if (input.needsInitiativeCount > 0) return 'needsInitiativeToStart';
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
  // Same roster rule as the standing hint, so the tooltip and the paragraph can never
  // disagree about WHICH roster step is outstanding.
  return startRosterHintReason(input);
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

/**
 * `t()`-resolve a gate reason key, or `undefined` when there is none.
 *
 * Lives beside the resolvers rather than in one component because `nextTurn` has three
 * entry points (the keyboard shortcut, the header button, and the lair-action card's
 * "Done →"), and a per-component copy of this is how the third one ended up without a
 * reason at all (issue #1933 review).
 */
export function gateReasonText(
  key: LifecycleGateReason,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  return key ? t(`run.gate.${key}`) : undefined;
}
