/**
 * Pure reorder index math (issue #1923) — Move up / Move down / drag-drop all resolve to
 * the same `afterCombatantId` (or `'top'`) contract the server expects.
 */
import { expect, test } from '@playwright/test';
import {
  afterCombatantIdForDrop,
  afterCombatantIdForMoveDown,
  afterCombatantIdForMoveUp,
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
