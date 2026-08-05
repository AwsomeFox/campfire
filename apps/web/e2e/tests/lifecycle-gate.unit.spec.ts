/**
 * DM lifecycle header gate reasons (issue #1933) — pins the priority between a safety
 * hold, the sync gate, and each button's own roster/turn-state condition, and that
 * `end`/`reopen`/`delete`/`rollInitiative` never claim a safety-hold reason the server
 * does not actually enforce for them (`EncountersService.assertNoSafetyHold` only guards
 * `start`, `nextTurn`, `undoTurn`, `endTurn`).
 */
import { expect, test } from '@playwright/test';
import {
  nextTurnGateReason,
  rollInitiativeGateReason,
  startGateReason,
  syncOnlyGateReason,
  undoTurnGateReason,
} from '../../src/features/encounters/lifecycleGate';

test.describe('rollInitiativeGateReason (issue #1933)', () => {
  test('nothing blocking: no reason', () => {
    expect(rollInitiativeGateReason({ riskyBlocked: false, needsInitiativeCount: 3 })).toBeNull();
  });
  test('sync gate wins over "already rolled"', () => {
    expect(rollInitiativeGateReason({ riskyBlocked: true, needsInitiativeCount: 0 })).toBe('syncBlocked');
  });
  test('every combatant already has initiative', () => {
    expect(rollInitiativeGateReason({ riskyBlocked: false, needsInitiativeCount: 0 })).toBe('allInitiativeRolled');
  });
});

test.describe('startGateReason (issue #1933)', () => {
  const base = { safetyHoldActive: false, riskyBlocked: false, hasNoCombatants: false, needsInitiativeCount: 0 };

  test('nothing blocking: no reason', () => {
    expect(startGateReason(base)).toBeNull();
  });
  test('a safety hold wins over every other condition', () => {
    expect(
      startGateReason({ ...base, safetyHoldActive: true, riskyBlocked: true, hasNoCombatants: true }),
    ).toBe('safetyHold');
  });
  test('sync gate wins over the roster conditions', () => {
    expect(startGateReason({ ...base, riskyBlocked: true, hasNoCombatants: true })).toBe('syncBlocked');
  });
  test('no combatants at all', () => {
    expect(startGateReason({ ...base, hasNoCombatants: true })).toBe('needsCombatantsToStart');
  });
  test('combatants exist but initiative is incomplete', () => {
    expect(startGateReason({ ...base, needsInitiativeCount: 2 })).toBe('needsInitiativeToStart');
  });
});

test.describe('undoTurnGateReason (issue #1933)', () => {
  const base = { safetyHoldActive: false, riskyBlocked: false, undoTurnDisabled: false };

  test('nothing blocking: no reason', () => {
    expect(undoTurnGateReason(base)).toBeNull();
  });
  test('a safety hold wins over the sync gate and "first turn"', () => {
    expect(
      undoTurnGateReason({ safetyHoldActive: true, riskyBlocked: true, undoTurnDisabled: true }),
    ).toBe('safetyHold');
  });
  test('sync gate wins over "first turn, nothing to undo"', () => {
    expect(undoTurnGateReason({ ...base, riskyBlocked: true, undoTurnDisabled: true })).toBe('syncBlocked');
  });
  test('the first turn of the fight: nothing earlier to undo', () => {
    expect(undoTurnGateReason({ ...base, undoTurnDisabled: true })).toBe('undoNothingToUndo');
  });
});

test.describe('nextTurnGateReason (issue #1933)', () => {
  test('nothing blocking: no reason', () => {
    expect(nextTurnGateReason({ safetyHoldActive: false, riskyBlocked: false })).toBeNull();
  });
  test('a safety hold wins over the sync gate', () => {
    expect(nextTurnGateReason({ safetyHoldActive: true, riskyBlocked: true })).toBe('safetyHold');
  });
  test('sync gate alone', () => {
    expect(nextTurnGateReason({ safetyHoldActive: false, riskyBlocked: true })).toBe('syncBlocked');
  });
});

test.describe('syncOnlyGateReason (issue #1933) — end/reopen/delete are not safety-hold guarded', () => {
  test('not sync-blocked: no reason', () => {
    expect(syncOnlyGateReason(false)).toBeNull();
  });
  test('sync-blocked: syncBlocked', () => {
    expect(syncOnlyGateReason(true)).toBe('syncBlocked');
  });
});
