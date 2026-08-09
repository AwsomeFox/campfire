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
 * What this function's `true` result actually MEANS: "since the reorder that armed this gate
 * settled, no real `GET /encounters/:id` has completed yet" — the precondition that must hold
 * before a further drag is authored, because only a completed GET can have observed the
 * server's post-reorder roster. `armedAt`/`readRevision` must therefore both be values of
 * `encounterReadRevisionRef` (see RunSessionPage.tsx) — a counter `encounterQuery`'s `queryFn`
 * increments ONLY after a fetch it started actually resolves (guarded by
 * `signal.throwIfAborted()` so a superseded in-flight request cannot count). It is
 * DELIBERATELY NOT `encounterQuery.dataUpdatedAt`: that TanStack-managed timestamp advances on
 * ANY `setQueryData` call for this query key, including the several local OPTIMISTIC writes
 * elsewhere on this page (HP deltas, map/fog patch reconciliation, ...) that touch fields other
 * than `combatants`/`turnVersion` and never round-trip to the server at all — gating on it
 * would let one of those land inside the window and clear the gate while the roster was still
 * stale, reopening exactly the silent-wrong-order hazard this function exists to prevent. (This
 * codebase already discovered and documented that exact hazard for a sibling problem — see
 * `encounterReadRevisionRef`'s own doc comment.)
 *
 * Returns `true` — "still waiting, keep the gate closed" — until `readRevision` is STRICTLY
 * greater than `armedAt` (`false` when `armedAt` is `null`: no reorder has settled since the
 * last resync, or since this last cleared). Deliberately independent of
 * `encounterQuery.isFetching`, which the issue rules out as the gating signal: `isFetching`
 * is true for ANY refetch (SSE invalidations, an unrelated write's own `onSettled`), so
 * gating on it would silently swallow a completed drag whenever one happened to overlap.
 */
export function isAwaitingReorderResync(armedAt: number | null, readRevision: number): boolean {
  return armedAt !== null && readRevision <= armedAt;
}

/**
 * Issue #2116 review round 7. `RunSessionPage` is reused across encounters — its route carries
 * no `key={encounterId}`, so navigating the DM from encounter A to encounter B re-renders the
 * SAME component instance instead of remounting it. `useMutation` (`@tanstack/react-query`)
 * calls `observer.setOptions(options)` in an effect on every render, and
 * `MutationObserver.setOptions` (`@tanstack/query-core`) splices those newest options straight
 * into an in-flight `Mutation` instance whenever its status is still `'pending'`. So if a drag
 * starts on encounter A and the DM navigates to encounter B before A's POST resolves, the
 * `onSettled` callback that actually executes is the one captured on B's most recent render —
 * closing over B, even though the completed write and its variables still belong to A.
 *
 * `writeEncounterId` must therefore come from the mutation's own variables (fixed once, as the
 * argument to its one `execute()` call, never subject to that options swap); `activeEncounterId`
 * must come from a ref updated fresh on every render (e.g. `activeEncounterIdRef.current`), read
 * at the moment `onSettled` actually runs. Only when the two still agree does a just-settled
 * write belong to the encounter currently on screen — arming the resync latch for anything else
 * would spuriously disable the DISPLAYED encounter's reorder affordances for a drag that was
 * never made against it.
 */
export function shouldArmReorderResyncLatch(writeEncounterId: number, activeEncounterId: number): boolean {
  return writeEncounterId === activeEncounterId;
}
