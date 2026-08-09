/**
 * Pure reorder index math (issue #1923) — Move up / Move down / drag-drop all resolve to
 * the same `afterCombatantId` (or `'top'`) contract the server expects.
 */
import { expect, test } from '@playwright/test';
import {
  afterCombatantIdForDrop,
  afterCombatantIdForMoveDown,
  afterCombatantIdForMoveUp,
  isAwaitingReorderResync,
  reorderMenuTargets,
  shouldArmReorderResyncLatch,
} from '../../src/features/encounters/combatantReorder';

const ORDER = [10, 20, 30, 40]; // Wizard, Fighter, Rogue, Cleric

test.describe('afterCombatantIdForMoveUp (issue #1923)', () => {
  test('moves a middle combatant up: lands after the entry two slots back', () => {
    // ORDER = [10, 20, 30, 40]; moving 30 up should land right after 10 (before 20).
    expect(afterCombatantIdForMoveUp(ORDER, 30)).toBe(10);
  });

  test('moving the second entry up sends it to the very top', () => {
    expect(afterCombatantIdForMoveUp(ORDER, 20)).toBe('top');
  });

  test('the first entry cannot move up (no-op, null)', () => {
    expect(afterCombatantIdForMoveUp(ORDER, 10)).toBeNull();
  });

  test('an unknown id is a no-op', () => {
    expect(afterCombatantIdForMoveUp(ORDER, 999)).toBeNull();
  });
});

test.describe('afterCombatantIdForMoveDown (issue #1923)', () => {
  test('moves a combatant down: lands after its current next sibling', () => {
    expect(afterCombatantIdForMoveDown(ORDER, 20)).toBe(30);
  });

  test('moving the first entry down swaps it past the second', () => {
    expect(afterCombatantIdForMoveDown(ORDER, 10)).toBe(20);
  });

  test('the last entry cannot move down (no-op, null)', () => {
    expect(afterCombatantIdForMoveDown(ORDER, 40)).toBeNull();
  });

  test('an unknown id is a no-op', () => {
    expect(afterCombatantIdForMoveDown(ORDER, 999)).toBeNull();
  });
});

test.describe('afterCombatantIdForDrop (issue #1923)', () => {
  test('dropping AFTER a target returns that target id directly', () => {
    expect(afterCombatantIdForDrop(ORDER, 40, 10, true)).toBe(10);
  });

  test('dropping BEFORE the first entry returns top', () => {
    expect(afterCombatantIdForDrop(ORDER, 40, 10, false)).toBe('top');
  });

  test('dropping BEFORE a non-first entry returns the entry preceding it (dragged excluded)', () => {
    // Drag 10 out, remaining order is [20, 30, 40]; dropping before 30 lands after 20.
    expect(afterCombatantIdForDrop(ORDER, 10, 30, false)).toBe(20);
  });

  test('dropping onto the dragged combatant itself is a no-op', () => {
    expect(afterCombatantIdForDrop(ORDER, 20, 20, true)).toBeNull();
  });

  test('an unknown target is a no-op', () => {
    expect(afterCombatantIdForDrop(ORDER, 20, 999, true)).toBeNull();
  });

  test('dragged-then-removed target position is resolved against the list WITHOUT the dragged entry', () => {
    // Dragging 10 after 40 directly (drop after last): whole list minus 10 is [20,30,40].
    expect(afterCombatantIdForDrop(ORDER, 10, 40, true)).toBe(40);
  });
});

test.describe('reorderMenuTargets (issue #1923)', () => {
  test('excludes the moved combatant itself, preserves the rest in order', () => {
    const combatants = [{ id: 10, name: 'Wizard' }, { id: 20, name: 'Fighter' }, { id: 30, name: 'Rogue' }];
    expect(reorderMenuTargets(combatants, 20).map((c) => c.id)).toEqual([10, 30]);
  });
});

test.describe('isAwaitingReorderResync (issue #2116)', () => {
  /**
   * `armedAt`/`readRevision` model VALUES OF `encounterReadRevisionRef` — a counter
   * `RunSessionPage.tsx`'s `encounterQuery` bumps ONLY inside its own `queryFn`, after a
   * fetch it started has actually resolved. `armedAt` is the value captured when a reorder
   * settles; `readRevision` is the counter's live value at some later point. See
   * `RunSessionPage.tsx`'s own use of this function for the full defect this closes: a drag
   * issued while `reorderCombatant.isPending` has already cleared but no real completed GET
   * newer than the settle-time baseline has landed would otherwise be authored against the
   * pre-reorder roster and silently accepted by the server's CAS (a reorder never bumps
   * `turnVersion`).
   *
   * This is deliberately gated on that read-revision counter and NOT on
   * `encounterQuery.dataUpdatedAt` — review on #2116 found an earlier version of this fix
   * used `dataUpdatedAt`, which TanStack Query also advances on local optimistic
   * `setQueryData` writes (an HP delta, a map/fog patch) that never round-trip to the
   * server, letting one of those falsely clear the gate mid-window. See the "an unrelated
   * optimistic write" case below, and the wiring tests in
   * `reorder-touch-and-sync-gate.unit.spec.ts` pinning that `dataUpdatedAt` is not used.
   */
  test('not awaiting when no reorder has settled since the ref was last cleared (armedAt: null)', () => {
    expect(isAwaitingReorderResync(null, 1_000)).toBe(false);
  });

  test('awaiting immediately after a reorder settles — the read that landed AT settle time does not itself clear it', () => {
    // readRevision === armedAt: the baseline read is the one already superseded by this
    // reorder's own write, not a read that postdates it.
    expect(isAwaitingReorderResync(1_000, 1_000)).toBe(true);
  });

  test('still awaiting while the only observed reads are OLDER than the settle-time baseline', () => {
    expect(isAwaitingReorderResync(1_000, 999)).toBe(true);
  });

  test('clears once a STRICTLY newer completed read has landed', () => {
    expect(isAwaitingReorderResync(1_000, 1_001)).toBe(false);
  });

  /**
   * The hazard found in review: an unrelated LOCAL optimistic write (HP delta, map/fog
   * patch) never advances `encounterReadRevisionRef` — only a real completed
   * `GET /encounters/:id` does. Modeled here by evaluating the gate repeatedly against the
   * SAME `readRevision` (standing in for "time passed and other, non-GET events fired, but
   * the read-revision counter itself never moved") — the gate must stay armed regardless of
   * how many times, or how much later, it is re-evaluated against an unmoved value. Fed
   * `encounterQuery.dataUpdatedAt` instead (the earlier, reverted approach), an intervening
   * optimistic write WOULD have advanced that timestamp and cleared the gate here.
   */
  test('an unrelated optimistic write that does not advance the read revision leaves the gate armed', () => {
    const armedAt = 5_000;
    expect(isAwaitingReorderResync(armedAt, armedAt)).toBe(true);
    // Re-evaluated again later, still against the same (unmoved) read-revision value.
    expect(isAwaitingReorderResync(armedAt, armedAt)).toBe(true);
    expect(isAwaitingReorderResync(armedAt, armedAt)).toBe(true);
  });

  /**
   * The exact scenario issue #2116 is filed about, replayed against the real predicate: a
   * reorder settles (arming the ref), a second drag is attempted before the triggered
   * refetch lands (must be refused), the refetch then lands (clearing the ref), and only
   * then is a further drag allowed. Reverting the fix — e.g. never arming the ref, or
   * clearing it unconditionally — makes this fail, unlike a response-shape-only assertion
   * (see the PR review discussion on #2116 for why the original, reverted fix's own
   * regression test failed to catch that it never actually changed client behavior).
   */
  test('a second drag inside the window is blocked; the same drag after the refetch lands is allowed', () => {
    const settleTimeReadRevision = 5_000;
    // The second drag is attempted before ANY newer completed read has landed — exactly the
    // gap between reorderCombatant.isPending clearing and invalidateEncounter's refetch
    // resolving that issue #2116 is about.
    expect(isAwaitingReorderResync(settleTimeReadRevision, settleTimeReadRevision)).toBe(true);

    // The triggered refetch (or another completed read, e.g. an SSE-driven one) lands after.
    const refetchLandedAtRevision = settleTimeReadRevision + 1;
    expect(isAwaitingReorderResync(settleTimeReadRevision, refetchLandedAtRevision)).toBe(false);
  });
});

test.describe('shouldArmReorderResyncLatch (issue #2116 review round 7)', () => {
  /**
   * `RunSessionPage` is reused across encounters (no `key={encounterId}` on its route), so a
   * reorder's `onSettled` can fire after the DM has navigated to a DIFFERENT encounter. See
   * this function's own doc comment, and the real-race component test in
   * `RunSessionPage.reorderCrossEncounterSettlement.spec.tsx`, for why this matters and how it
   * is provably a real `@tanstack/react-query` behavior, not a hypothetical one.
   */
  test('a write settling while its OWN encounter is still active arms the latch', () => {
    expect(shouldArmReorderResyncLatch(101, 101)).toBe(true);
  });

  test('a write settling AFTER the DM has navigated to a different encounter does not arm the latch', () => {
    // Encounter 101's reorder settles while encounter 202 is now the one on screen.
    expect(shouldArmReorderResyncLatch(101, 202)).toBe(false);
  });

  test('order of the two ids does not matter — only equality does', () => {
    expect(shouldArmReorderResyncLatch(202, 101)).toBe(false);
  });
});
