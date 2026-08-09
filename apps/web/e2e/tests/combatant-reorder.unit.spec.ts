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
   * `armedAt` models the `encounterQuery.dataUpdatedAt` baseline `RunSessionPage.tsx`
   * captures when a reorder settles; `dataUpdatedAt` models the encounter query's live
   * value at some later point. See RunSessionPage.tsx's own use of this function for the
   * full defect this closes: a drag issued while `reorderCombatant.isPending` has already
   * cleared but no read newer than the settle-time baseline has landed would otherwise be
   * authored against the pre-reorder roster and silently accepted by the server's CAS
   * (a reorder never bumps `turnVersion`).
   */
  test('not awaiting when no reorder has settled since the ref was last cleared (armedAt: null)', () => {
    expect(isAwaitingReorderResync(null, 1_000)).toBe(false);
  });

  test('awaiting immediately after a reorder settles — the read that landed AT settle time does not itself clear it', () => {
    // dataUpdatedAt === armedAt: the baseline read is the one already superseded by this
    // reorder's own write, not a read that postdates it.
    expect(isAwaitingReorderResync(1_000, 1_000)).toBe(true);
  });

  test('still awaiting while the only observed reads are OLDER than the settle-time baseline', () => {
    expect(isAwaitingReorderResync(1_000, 999)).toBe(true);
  });

  test('clears once a STRICTLY newer read has landed', () => {
    expect(isAwaitingReorderResync(1_000, 1_001)).toBe(false);
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
    const settleTimeDataUpdatedAt = 5_000;
    // The second drag is attempted before ANY newer read has landed — exactly the gap
    // between reorderCombatant.isPending clearing and invalidateEncounter's refetch
    // resolving that issue #2116 is about.
    expect(isAwaitingReorderResync(settleTimeDataUpdatedAt, settleTimeDataUpdatedAt)).toBe(true);

    // The triggered refetch (or any other read, e.g. an SSE-driven one) lands afterward.
    const refetchLandedAt = settleTimeDataUpdatedAt + 250;
    expect(isAwaitingReorderResync(settleTimeDataUpdatedAt, refetchLandedAt)).toBe(false);
  });
});
