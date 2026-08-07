/**
 * Pure helpers for the DM manual initiative reorder (issue #1923). Drag (InitiativeStrip
 * + the roster) and the accessible "Move up / Move down / Move after…" fallback menu all
 * resolve to the same server contract — an `afterCombatantId` (or the literal `'top'`) —
 * so every entry point composes these instead of re-deriving index math independently.
 *
 * `orderedIds` is always the CURRENT server-rendered order (`encounter.combatants` ids,
 * issue #49 — never a client re-sort), so an id-based reference here can never point at a
 * position that has since shifted under a concurrent write; the server's own
 * `expectedTurnVersion` CAS still guards against ordering against a stale roster entirely.
 */

/** One entry away from becoming first — `null` when already first (no-op). */
export function afterCombatantIdForMoveUp(orderedIds: readonly number[], combatantId: number): number | 'top' | null {
  const index = orderedIds.indexOf(combatantId);
  if (index <= 0) return null;
  const beforePrevious = index - 2;
  return beforePrevious >= 0 ? orderedIds[beforePrevious] : 'top';
}

/** One entry toward the back — `null` when already last (no-op). */
export function afterCombatantIdForMoveDown(orderedIds: readonly number[], combatantId: number): number | null {
  const index = orderedIds.indexOf(combatantId);
  if (index === -1 || index >= orderedIds.length - 1) return null;
  return orderedIds[index + 1];
}

/**
 * Resolve a drag/drop (or an explicit "Move after X") onto a target combatant plus which
 * side of it the pointer released over, into the `afterCombatantId` the server expects.
 * Dropping before the roster's current first entry yields `'top'`. A drop onto the
 * dragged combatant itself, or an unknown target, is a no-op (`null`) — the caller must
 * not fire a request for either.
 */
export function afterCombatantIdForDrop(
  orderedIds: readonly number[],
  draggedId: number,
  targetId: number,
  dropAfterTarget: boolean,
): number | 'top' | null {
  if (targetId === draggedId) return null;
  const withoutDragged = orderedIds.filter((id) => id !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex === -1) return null;
  if (dropAfterTarget) return targetId;
  return targetIndex === 0 ? 'top' : withoutDragged[targetIndex - 1];
}

/** Every OTHER combatant, for the "Move after…" picker — excludes the moved one itself. */
export function reorderMenuTargets<T extends { id: number }>(orderedCombatants: readonly T[], combatantId: number): T[] {
  return orderedCombatants.filter((c) => c.id !== combatantId);
}
