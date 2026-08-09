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

/**
 * Issue #2116. `handleReorderDrop`'s in-flight gate refuses while `reorderCombatant.isPending`
 * — but that flips false the instant the reorder POST resolves, before the follow-up refetch
 * it triggers has actually landed. A drag issued in that window would be authored against
 * whatever roster is STILL in the query cache — the pre-reorder topology — and the server's
 * `expectedTurnVersion` CAS would still accept it (a reorder never bumps `turnVersion`, only a
 * turn advance does), so the request would silently apply relative to an order the DM can no
 * longer see: a wrong-result path, not the recoverable-409 the CAS otherwise guards.
 *
 * `armedAt` is the `encounterQuery.dataUpdatedAt` baseline captured the moment a reorder
 * settled (`null` when no reorder has settled since the last resync, or since this last
 * cleared). This returns `true` — "still waiting, keep the gate closed" — until a read
 * STRICTLY NEWER than that baseline lands (`dataUpdatedAt > armedAt`); the read that merely
 * triggered the refetch does not itself count. Deliberately independent of
 * `encounterQuery.isFetching`, which the issue rules out as the gating signal: `isFetching`
 * is true for ANY refetch (SSE invalidations, an unrelated write's own `onSettled`), so
 * gating on it would silently swallow a completed drag whenever one happened to overlap.
 */
export function isAwaitingReorderResync(armedAt: number | null, dataUpdatedAt: number): boolean {
  return armedAt !== null && dataUpdatedAt <= armedAt;
}
