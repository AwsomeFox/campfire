import { expect, test } from '@playwright/test';
import {
  classifyDeathSaveOutcome,
  deathSaveRollNatural,
  deathSaveSpectatorToastInfo,
  isDeathSaveRollEvent,
} from '../../src/features/encounters/combat/deathSaveOutcome';

// Issue #1919 — the death save must read as a distinct table moment (revive / death /
// stabilization / plain success/failure), not just a pip count. This table mirrors
// `deathSaveRollEventDetail`'s ordering in encounters.service.ts exactly, so the roller's
// tracker and the server's own combat-log/audit text agree on every outcome.
test.describe('classifyDeathSaveOutcome (issue #1919)', () => {
  const cases: Array<[natural: number, before: string, after: string, expected: string]> = [
    // Nat 20 always reads as a revive, regardless of the resulting deathState.
    [20, 'dying', 'none', 'revive'],
    [20, 'stable', 'none', 'revive'],
    // A fresh transition to dead — including a nat 1 pushing a 2-failure combatant over.
    [1, 'dying', 'dead', 'dead'],
    [2, 'dying', 'dead', 'dead'],
    [9, 'dying', 'dead', 'dead'],
    // Already dead is not a FRESH transition — falls through to plain success/failure.
    [15, 'dead', 'dead', 'success'],
    // A fresh transition to stable (third success).
    [10, 'dying', 'stable', 'stabilized'],
    [19, 'dying', 'stable', 'stabilized'],
    // Already stable is not a fresh transition either.
    [12, 'stable', 'stable', 'success'],
    // Plain success (10-19) / failure (2-9) with no state transition.
    [10, 'dying', 'dying', 'success'],
    [19, 'dying', 'dying', 'success'],
    [2, 'dying', 'dying', 'failure'],
    [9, 'dying', 'dying', 'failure'],
    [1, 'dying', 'dying', 'failure'],
  ];

  for (const [natural, before, after, expected] of cases) {
    test(`natural ${natural}, ${before} -> ${after} classifies as ${expected}`, () => {
      expect(classifyDeathSaveOutcome(natural, before, after)).toBe(expected);
    });
  }
});

test.describe('death-save roll event detection (issue #1919)', () => {
  test('recognizes the exact prefix deathSaveRollEventDetail always writes', () => {
    expect(
      isDeathSaveRollEvent({
        type: 'roll',
        detail: 'death save d20 roll 15: Success (rolled 15) — totals: 1 succ / 0 fail',
      }),
    ).toBe(true);
    expect(
      isDeathSaveRollEvent({
        type: 'roll',
        detail: 'death save d20 roll 20: Natural 20! Revived with 1 HP!',
      }),
    ).toBe(true);
  });

  test('does not match an ordinary roll or a non-roll event', () => {
    expect(isDeathSaveRollEvent({ type: 'roll', detail: 'Attack roll 1d20+5: 18' })).toBe(false);
    expect(isDeathSaveRollEvent({ type: 'damage', detail: 'death save d20 roll 15: Success' })).toBe(false);
  });

  test('extracts the natural face from the detail text', () => {
    expect(deathSaveRollNatural('death save d20 roll 15: Success (rolled 15) — totals: 1 succ / 0 fail')).toBe(15);
    expect(deathSaveRollNatural('death save d20 roll 1: Natural 1! (2 failures) — totals: 0 succ / 2 fail')).toBe(1);
    expect(deathSaveRollNatural('death save d20 roll 20: Natural 20! Revived with 1 HP!')).toBe(20);
    expect(deathSaveRollNatural('Attack roll 1d20+5: 18')).toBe(null);
  });
});

// Issue #1919 — SECRECY BOUNDARY: the "table side" spectator toast must never expose a
// combatant identity the server has not already decided to reveal. The server redacts a
// hidden combatant's name to the literal "Unknown combatant" placeholder (encounters.logic.ts's
// `redactEncounterEventsForViewer`, issue #869 — see its own death-save-shaped `type: 'roll'`
// regression case in encounters-logic.spec.ts). This pins the CLIENT half of that boundary:
// `deathSaveSpectatorToastInfo` only ever reads `event.target` verbatim from the already
// role-projected event — it must pass a redacted placeholder straight through unchanged,
// never re-derive or "fix" it back to a real name, and never fabricate one when absent.
test.describe('deathSaveSpectatorToastInfo secrecy boundary (issue #1919)', () => {
  test('passes an already-redacted target straight through, never re-deriving the real name', () => {
    expect(
      deathSaveSpectatorToastInfo({
        type: 'roll',
        detail: 'death save d20 roll 15: Success (rolled 15) — totals: 1 succ / 0 fail',
        target: 'Unknown combatant',
      }),
    ).toEqual({ name: 'Unknown combatant', natural: 15, outcomeKind: 'success' });
  });

  test('produces no toast at all when the event carries no resolvable name (never fabricates one)', () => {
    expect(
      deathSaveSpectatorToastInfo({
        type: 'roll',
        detail: 'death save d20 roll 15: Success (rolled 15) — totals: 1 succ / 0 fail',
        target: null,
      }),
    ).toBeNull();
    expect(
      deathSaveSpectatorToastInfo({
        type: 'roll',
        detail: 'death save d20 roll 15: Success (rolled 15) — totals: 1 succ / 0 fail',
        target: '   ',
      }),
    ).toBeNull();
  });

  test('a genuinely visible target passes through with the correct success/failure split', () => {
    expect(
      deathSaveSpectatorToastInfo({ type: 'roll', detail: 'death save d20 roll 3: Failure (rolled 3)', target: 'Aria' }),
    ).toEqual({ name: 'Aria', natural: 3, outcomeKind: 'failure' });
  });

  test('ignores a non-death-save roll or non-roll event regardless of target', () => {
    expect(deathSaveSpectatorToastInfo({ type: 'roll', detail: 'Attack roll 1d20+5: 18', target: 'Aria' })).toBeNull();
    expect(
      deathSaveSpectatorToastInfo({ type: 'damage', detail: 'death save d20 roll 15: Success', target: 'Aria' }),
    ).toBeNull();
  });
});
