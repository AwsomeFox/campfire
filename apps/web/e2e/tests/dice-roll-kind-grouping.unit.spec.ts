import { expect, test } from '@playwright/test';
import type { DiceRoll, DiceRollKind } from '@campfire/schema';
import { diceRollGroupRole, diceRollKindAccentVar } from '../../src/features/dice/diceRollDisplay';

/**
 * Shared dice log literal per-kind grouping (issue #2183, follow-up to #2155/#2182).
 * Pure-function coverage for `diceRollGroupRole`, the run-boundary logic the
 * component's border/tint treatment reads from. The real rendered-DOM assertion
 * lives in `dice-log-kind-grouping.spec.ts` (a browser spec) — this file is
 * fast, exhaustive edge-case coverage of the same function in isolation.
 */
function roll(kind: DiceRollKind | undefined, id = 0): DiceRoll {
  return {
    id,
    campaignId: 1,
    expr: '1d20',
    rolls: [10],
    total: 10,
    createdAt: new Date().toISOString(),
    rollerUserId: 'u1',
    kind,
  } as unknown as DiceRoll;
}

test.describe('diceRollGroupRole (#2183)', () => {
  test('an unclassified roll is always solo, even flanked by the same real kind on both sides', () => {
    const rolls = [roll('check', 1), roll(undefined, 2), roll('check', 3)];
    expect(diceRollGroupRole(rolls, 1)).toBe('solo');
    // And it never extends a neighbour's run either — both real-kind rows report solo too,
    // since their one same-kind neighbour is on the OTHER side of the unclassified row.
    expect(diceRollGroupRole(rolls, 0)).toBe('solo');
    expect(diceRollGroupRole(rolls, 2)).toBe('solo');
  });

  test('a lone kind with different-kind neighbours on both sides is solo', () => {
    const rolls = [roll('to-hit', 1), roll('damage', 2), roll('check', 3)];
    expect(diceRollGroupRole(rolls, 1)).toBe('solo');
  });

  test('a run of 2 is start then end, never middle', () => {
    const rolls = [roll('roll', 1), roll('roll', 2)];
    expect(diceRollGroupRole(rolls, 0)).toBe('start');
    expect(diceRollGroupRole(rolls, 1)).toBe('end');
  });

  test('a run of 3+ has exactly one start, middles in between, one end', () => {
    const rolls = [roll('check', 1), roll('check', 2), roll('check', 3), roll('check', 4)];
    expect(rolls.map((_, i) => diceRollGroupRole(rolls, i))).toEqual(['start', 'middle', 'middle', 'end']);
  });

  test('a run never bridges a different kind sitting between two same-kind rows', () => {
    // check, roll, check — the two `check` rows are NOT chronologically adjacent, so
    // neither is grouped with the other, whatever the array looks like at a distance.
    const rolls = [roll('check', 1), roll('roll', 2), roll('check', 3)];
    expect(rolls.map((_, i) => diceRollGroupRole(rolls, i))).toEqual(['solo', 'solo', 'solo']);
  });

  test('the single-row array is always solo', () => {
    expect(diceRollGroupRole([roll('damage', 1)], 0)).toBe('solo');
  });

  test('every real kind resolves an accent var; unclassified resolves none', () => {
    const kinds: DiceRollKind[] = ['to-hit', 'damage', 'check', 'roll'];
    const seen = new Set<string>();
    for (const kind of kinds) {
      const accent = diceRollKindAccentVar(kind);
      expect(accent).not.toBeNull();
      expect(seen.has(accent!)).toBe(false);
      seen.add(accent!);
    }
    expect(diceRollKindAccentVar(undefined)).toBeNull();
  });
});
