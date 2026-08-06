/**
 * Why a DM lifecycle header control is disabled right now (issue #1933) — kept pure so the
 * priority between a safety hold, the sync gate, and each button's own roster/turn-state
 * condition can be pinned in a `.unit.spec.ts` without a browser.
 *
 * Which writes the safety hold actually stops, so a gate reason never claims more than the
 * server enforces (issue #599). `EncountersService.assertNoSafetyHold` guards `start`,
 * `nextTurn`, `undoTurn` and `endTurn`; `ActionResolverService.apply` has its own
 * `assertNotHeld` (see {@link actionApplyGateReason}). `end`/`reopen`/`delete`/
 * `rollInitiative` are NOT guarded, and neither is `resolve` — the action PREVIEW stays
 * open during a hold on purpose, since computing a number nobody has committed is harmless
 * and hiding it would keep the table from seeing what was about to happen. So
 * `safetyHoldActive` is only a resolver input where the server actually rejects the write:
 * gating a control the server would have allowed is the same defect as leaving one
 * ungated, pointed the other way.
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
 * Applying a resolved action — guarded by `ActionResolverService.apply`'s own
 * `assertNotHeld`, which is a SEPARATE gate from `EncountersService.assertNoSafetyHold`
 * (issue #1933 review). Applying writes damage, conditions and death saves to the board:
 * that is play advancing, and it is exactly what someone raising an X-Card mid-swing is
 * asking to stop.
 *
 * Scoped to the Apply control only. The preview/roll controls beside it are deliberately
 * left alone — the server keeps `resolve` open during a hold, so gating them would disable
 * something it would have allowed.
 */
export function actionApplyGateReason(input: {
  safetyHoldActive: boolean;
  riskyBlocked: boolean;
}): LifecycleGateReason {
  if (input.safetyHoldActive) return 'safetyHold';
  if (input.riskyBlocked) return 'syncBlocked';
  return null;
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
  busy = false,
): string | undefined {
  // `busy` (a request already in flight) suppresses the reason entirely rather than
  // competing with it (issue #1933 review). `GatedControl` strips the native `disabled`
  // attribute whenever a reason is present, so a control that is disabled BECAUSE a request
  // is in flight, and which also happens to match some other gate, would otherwise become
  // focusable and announce a reason that is not the operative blocker — telling the DM the
  // table is paused when the truth is "your last click is still going". Returning undefined
  // leaves it natively disabled with no reason claimed, which is honest and matches the rule
  // `syncGateReason` already applies to the death-save controls.
  if (busy) return undefined;
  return key ? t(`run.gate.${key}`) : undefined;
}

/**
 * Turn timer preset control (issue #1935 review): a PATCH of `turnTimerSeconds` on an
 * 'ended' encounter 409s via `assertMutable`, same as every other write in this header —
 * so this control must be gated exactly like its siblings, not left permanently visible
 * and enabled. `reopen` is true only in the 'ended' status (see the status→action matrix
 * in `encounterLifecycleActions.ts`), so it doubles as "is this encounter ended" without
 * a second lifecycle field.
 */
export function turnTimerControlVisible(reopenAllowed: boolean): boolean {
  return !reopenAllowed;
}

/** Disabled alongside the other conflict-prone writes in this header: a request already
 *  in flight, or a stale sync state the DM hasn't reconciled yet. */
export function turnTimerControlDisabled(input: { headerBusy: boolean; riskyBlocked: boolean }): boolean {
  return input.headerBusy || input.riskyBlocked;
}
