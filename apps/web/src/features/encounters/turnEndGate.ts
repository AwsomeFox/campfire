/**
 * Why the End-turn control is disabled right now (issue #1933) — kept pure so the
 * priority between a safety hold, the sync gate, and the DM-controls-turns setting can be
 * pinned in a `.unit.spec.ts` without a browser.
 *
 * `TurnWorkspace` only ever renders for the DM or the current combatant's OWNER (server-side
 * disclosure gate — see the component doc comment), so a plain "not your turn" state is not
 * reachable here: a player only sees this panel when it IS their combatant's turn. That's why
 * this resolver has nothing to say for a `false` result other than `null` — the caller's
 * unreachable-in-practice fallback stays exactly as it already was.
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
  // A safety hold rejects the write regardless of any other condition (#599) — surface it
  // first so a player doesn't chase a "DM controls turns" explanation for a stopped table.
  if (input.safetyHoldActive) return 'safetyHold';
  if (!input.canEndTurn) {
    return input.isYourTurn && input.dmControlsTurns ? 'dmControlsTurns' : null;
  }
  if (input.syncBlocked) return 'syncBlocked';
  return null;
}
