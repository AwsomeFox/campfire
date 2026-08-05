/**
 * Why the End-turn control is disabled right now (issue #1933) — kept pure so the
 * priority between applicability, a safety hold, the sync gate, and the DM-controls-turns
 * setting can be pinned in a `.unit.spec.ts` without a browser.
 *
 * `TurnWorkspace` renders for EVERY viewer of a running encounter, not only the DM or the
 * current combatant's owner (only the detailed action-economy/prompts/suggestions section is
 * owner/DM-gated — see that component's doc comment); a plain onlooker gets
 * `canEndTurn: false, isYourTurn: false`. APPLICABILITY — whether this control is even this
 * viewer's to press — must therefore be decided FIRST, before any reason (including a safety
 * hold) is layered on: a hold is a reason the button STAYS but explains itself, not a reason
 * the button starts existing for a viewer who never had one. Getting this order backwards
 * previously made a disabled End-turn button flicker into existence for onlookers for the
 * duration of every safety hold, then disappear again — an unintended mount/unmount change
 * the reason-mirror was never meant to introduce.
 */

export type TurnEndGateReason = 'safetyHold' | 'syncBlocked' | 'dmControlsTurns' | null;

export function turnEndGateReason(input: {
  /** Server-computed: DM always; a player only on their own turn when dmControlsTurns is false. */
  canEndTurn: boolean;
  isYourTurn: boolean;
  dmControlsTurns: boolean;
  /** #599 — assertNoSafetyHold rejects endTurn server-side; mirrored here via useTableSafety. */
  safetyHoldActive: boolean;
  /** #471/#1446 — encounterActionsBlocked: the sync/read gate for conflict-prone writes. */
  syncBlocked: boolean;
}): TurnEndGateReason {
  // Applicability first: a plain onlooker (neither the DM nor this turn's owner) has no
  // End-turn control to explain, regardless of any other condition.
  const applicable = input.canEndTurn || input.isYourTurn;
  if (!applicable) return null;

  // A safety hold rejects the write regardless of any other condition (#599) — surface it
  // first so a player doesn't chase a "DM controls turns" explanation for a stopped table.
  if (input.safetyHoldActive) return 'safetyHold';
  if (!input.canEndTurn) {
    // Applicable + !canEndTurn implies isYourTurn (from the check above).
    return input.dmControlsTurns ? 'dmControlsTurns' : null;
  }
  if (input.syncBlocked) return 'syncBlocked';
  return null;
}

/**
 * The STANDING reason, independent of the transient gates (issue #1933 review).
 *
 * `dmControlsTurns` is a campaign SETTING, not a passing condition: it is true for the whole
 * fight, and it is the answer to "why can I never end my own turn here". A safety hold or a
 * sync outage are the opposite — momentary, and worth a tooltip. Before `GatedControl` was
 * adopted, this setting had a permanently visible line beside the button; folding it into the
 * priority-ranked resolver put it behind hover/focus/tap, so a sighted mouse user who never
 * hovers saw a dead control with no explanation. Same category as the Start button's roster
 * hints, and it gets the same standing treatment.
 *
 * Returns only `dmControlsTurns`, never the transient keys, and only for a viewer the control
 * actually belongs to — an onlooker has no button to explain.
 */
export function turnEndStandingReason(input: {
  canEndTurn: boolean;
  isYourTurn: boolean;
  dmControlsTurns: boolean;
}): Extract<TurnEndGateReason, 'dmControlsTurns'> | null {
  const applicable = input.canEndTurn || input.isYourTurn;
  if (!applicable) return null;
  // Applicable + !canEndTurn implies isYourTurn, matching turnEndGateReason's own branch.
  if (!input.canEndTurn && input.dmControlsTurns) return 'dmControlsTurns';
  return null;
}
