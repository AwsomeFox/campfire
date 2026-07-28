import { expect, test } from '@playwright/test';
import { Dnd5eAdapter, Pf2eAdapter } from '@campfire/schema';
import { conditionLevel, findLeveledConditionTrack } from '../../src/features/characters/leveledCondition';

/**
 * Issue #1643 — exhaustion shown as a level (1-6), rule-system aware, capped at the
 * system's max. These are the pure helpers CharacterPage.tsx renders from
 * (leveledCondition.ts); see mcp.e2e-spec.ts's two "#1643:" tests for the server-side
 * proof that adjust_character_condition_level actually works end-to-end (5e Exhaustion,
 * and a 400 on a PF2e campaign that declares no track at all).
 */
test.describe('findLeveledConditionTrack — adapter-driven, never hardcoded (#1643)', () => {
  test('5e declares Exhaustion, capped at 6', () => {
    const track = findLeveledConditionTrack(Dnd5eAdapter);
    expect(track).toEqual({ name: 'Exhaustion', max: 6 });
  });

  // The case "most likely to be skipped" per the issue: a system whose adapter has no
  // exhaustion track must not render a 5e-shaped 1-6 widget. PF2e is the issue's own
  // named negative case.
  test('PF2e declares no leveled condition track — CharacterPage renders nothing for it', () => {
    expect(findLeveledConditionTrack(Pf2eAdapter)).toBeUndefined();
  });
});

test.describe('conditionLevel — reads stacks off conditionInstances, defaults to 0 (#1643)', () => {
  const track = { name: 'Exhaustion' };

  test('no instance at all is level 0 (not present), not level 1', () => {
    expect(conditionLevel(track, { conditionInstances: [] })).toBe(0);
  });

  test('reads the current stacks when the instance exists', () => {
    expect(
      conditionLevel(track, {
        conditionInstances: [{ id: 'legacy_exhaustion', name: 'Exhaustion', stacks: 3 } as never],
      }),
    ).toBe(3);
  });

  test('is case-insensitive and trims, matching the server-side reconciliation in common/conditions.ts', () => {
    expect(
      conditionLevel(track, {
        conditionInstances: [{ id: 'legacy_exhaustion', name: '  exhaustion  ', stacks: 2 } as never],
      }),
    ).toBe(2);
  });

  test('an unrelated condition on the sheet does not affect the read', () => {
    expect(
      conditionLevel(track, {
        conditionInstances: [{ id: 'legacy_poisoned', name: 'Poisoned', stacks: 1 } as never],
      }),
    ).toBe(0);
  });
});
