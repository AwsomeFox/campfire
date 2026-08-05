/**
 * DM lifecycle header gate reasons (issue #1933) — pins the priority between a safety
 * hold, the sync gate, and each button's own roster/turn-state condition, and that
 * `end`/`reopen`/`delete`/`rollInitiative` never claim a safety-hold reason the server
 * does not actually enforce for them (`EncountersService.assertNoSafetyHold` only guards
 * `start`, `nextTurn`, `undoTurn`, `endTurn`).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  nextTurnGateReason,
  rollInitiativeGateReason,
  startGateReason,
  startRosterHintReason,
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

/**
 * Issue #1933 review round 2. The standing roster paragraph under Start was derived from
 * `startGateReason`'s single winning key, so a safety hold or a sync outage — both of which
 * outrank the roster in that resolver — silently deleted the "add a combatant" / "roll
 * initiative" instruction from the screen. That is precisely when a DM staring at a
 * greyed-out Start most needs to know which setup step is still owed, and the transient
 * reason was only reachable by hover/focus/tap. The hint therefore resolves independently.
 */
test.describe('startRosterHintReason (issue #1933) — standing, not priority-ranked', () => {
  test('no roster problem: no hint', () => {
    expect(startRosterHintReason({ hasNoCombatants: false, needsInitiativeCount: 0 })).toBeNull();
  });
  test('no combatants at all', () => {
    expect(startRosterHintReason({ hasNoCombatants: true, needsInitiativeCount: 0 })).toBe('needsCombatantsToStart');
  });
  test('combatants exist but initiative is incomplete', () => {
    expect(startRosterHintReason({ hasNoCombatants: false, needsInitiativeCount: 2 })).toBe('needsInitiativeToStart');
  });

  // The regression itself: these are the two states where the old derivation dropped it.
  test('survives a safety hold — the roster step is still what the DM must fix', () => {
    const roster = { hasNoCombatants: true, needsInitiativeCount: 0 };
    expect(startGateReason({ ...roster, safetyHoldActive: true, riskyBlocked: false })).toBe('safetyHold');
    expect(startRosterHintReason(roster)).toBe('needsCombatantsToStart');
  });
  test('survives a sync outage', () => {
    const roster = { hasNoCombatants: false, needsInitiativeCount: 3 };
    expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: true })).toBe('syncBlocked');
    expect(startRosterHintReason(roster)).toBe('needsInitiativeToStart');
  });

  // ...while still agreeing with the tooltip about WHICH roster step it is, whenever the
  // gate resolver gets far enough down its priority list to name one at all.
  test('agrees with startGateReason whenever no transient gate outranks the roster', () => {
    for (const hasNoCombatants of [false, true]) {
      for (const needsInitiativeCount of [0, 1, 5]) {
        const roster = { hasNoCombatants, needsInitiativeCount };
        expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: false })).toBe(
          startRosterHintReason(roster),
        );
      }
    }
  });
});

/**
 * The resolver above only helps if the header actually calls it for the paragraph. A pure
 * unit test cannot see a component that goes back to deriving the hint from
 * `startGateReason`'s winning key — which is exactly how the first fix for this shipped —
 * so pin the source too. (The user-visible proof lives in the browser spec
 * `gated-control-start-hint.spec.ts`, which raises a real safety hold over REST and asserts
 * the paragraph is still on screen; this is the cheap guard that fails in seconds.)
 */
test.describe('DmLifecycleHeader adoption (issue #1933)', () => {
  test('the standing paragraph is resolved independently of the gate priority', () => {
    const code = readFileSync(
      resolve(__dirname, '../../src/features/encounters/DmLifecycleHeader.tsx'),
      'utf8',
    );

    expect(code).toMatch(/const standingHintKey = startRosterHintReason\(\{ hasNoCombatants, needsInitiativeCount \}\)/);
    // The paragraph renders off the standing key; only the GatedControl reason uses the
    // priority-ranked one.
    expect(code).toMatch(/\{standingHint && \(/);
    expect(code).not.toMatch(/startReasonKey === 'needsCombatantsToStart'/);
    // ...and it stays wired to the button for assistive tech, as it was before #1933.
    expect(code).toMatch(/aria-describedby=\{standingHint \? START_ROSTER_HINT_ID : undefined\}/);
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
