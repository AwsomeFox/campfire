import { rulerDistanceFeet } from './rulerReadout';

/**
 * Live movement-budget line while dragging the current actor's token (issue #1911).
 * `usedFt` is the combatant's already-committed `movementUsedFt` plus this drag's
 * in-flight straight-line distance; `maxFt` is the turn-workspace movement max
 * (`TurnWorkspaceRead.movement.maxFt`) — advisory only, never a hard cap.
 */
export type DragBudget = {
  usedFt: number;
  maxFt: number;
  /** True once `usedFt` exceeds `maxFt`. The caller renders an "over speed" hint but
   * never blocks the drop on this — movement remains DM-fiat, exactly like the manual
   * ± steppers in TurnWorkspace. */
  overBudget: boolean;
};

/**
 * Compose the "used X of Y" budget line. `movementUsedFt` comes straight off the
 * dragged combatant's `turnState` (visible to every viewer, same as HP); `inFlightFt`
 * is this drag's current distance in the encounter's real-world unit, from
 * `rulerDistanceFeet` — the SAME conversion the Measure tool's readout uses, so the two
 * can never drift apart over a hardcoded per-cell constant.
 */
export function dragBudget(movementUsedFt: number, inFlightFt: number, maxFt: number): DragBudget {
  const usedFt = Math.round((movementUsedFt + inFlightFt) * 100) / 100;
  return { usedFt, maxFt, overBudget: usedFt > maxFt };
}

/** Round a fractional grid-cell distance to the grid's own step (whole cells) — used only
 * for the `moveFt` POST on drop, never for the live readout (which stays fractional to
 * match the Measure tool exactly). */
export function roundCellsToGridStep(cells: number): number {
  return Math.round(cells);
}

/**
 * Feet to declare as `moveFt` when a token drag is committed: the whole-cell distance
 * (rounded to the grid step) times the encounter's own per-cell `gridScale` — never a
 * hardcoded 5 ft/square. Zero when the drop lands back on the origin cell.
 */
export function dragMoveFt(cells: number, gridScale: number): number {
  return rulerDistanceFeet(roundCellsToGridStep(cells), gridScale);
}

/**
 * True only when the dragged combatant is the current actor of a RUNNING encounter —
 * the sole case where a token drag both shows a movement budget and writes turn-state
 * on drop (issue #1911). Off-turn drags and DM repositioning of any other combatant
 * still show the plain distance readout, but this gate keeps them write-free.
 */
export function isCurrentActorDrag(
  encounterStatus: string,
  currentTurnCombatantId: number | null | undefined,
  draggedCombatantId: number,
): boolean {
  return encounterStatus === 'running' && currentTurnCombatantId != null && currentTurnCombatantId === draggedCombatantId;
}
