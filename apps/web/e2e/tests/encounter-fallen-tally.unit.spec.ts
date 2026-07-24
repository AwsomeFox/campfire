/**
 * End-of-combat Dead vs Downed tally (issue #492).
 *
 * A stable/dying PC at 0 HP must not count as Dead; a dead PC and a downed
 * monster must. Pure unit suite via pw-unit (no server / browser).
 */
import { expect, test } from '@playwright/test';
import {
  endedSummaryTallies,
  isDead,
  isDowned,
} from '../../src/features/encounters/encounterEndedSummary';

test.describe('encounter ended summary tallies (issue #492)', () => {
  test('stable PC at 0 is downed, not dead', () => {
    const pc = {
      name: 'Aria',
      kind: 'character' as const,
      hpCurrent: 0,
      deathState: 'stable',
    };
    expect(isDead(pc)).toBe(false);
    expect(isDowned(pc)).toBe(true);
  });

  test('dying PC at 0 is downed, not dead', () => {
    const pc = {
      name: 'Bran',
      kind: 'character' as const,
      hpCurrent: 0,
      deathState: 'dying',
    };
    expect(isDead(pc)).toBe(false);
    expect(isDowned(pc)).toBe(true);
  });

  test('dead PC counts as dead', () => {
    const pc = {
      name: 'Cora',
      kind: 'character' as const,
      hpCurrent: 0,
      deathState: 'dead',
    };
    expect(isDead(pc)).toBe(true);
    expect(isDowned(pc)).toBe(false);
  });

  test('monster at 0 counts as dead (defeated), not downed', () => {
    const monster = {
      name: 'Goblin',
      kind: 'monster' as const,
      hpCurrent: 0,
      deathState: 'none',
    };
    expect(isDead(monster)).toBe(true);
    expect(isDowned(monster)).toBe(false);
  });

  test('endedSummaryTallies splits dead / downed / survivors', () => {
    const { dead, downed, survivors } = endedSummaryTallies([
      { name: 'Aria', kind: 'character', hpCurrent: 0, deathState: 'stable' },
      { name: 'Cora', kind: 'character', hpCurrent: 0, deathState: 'dead' },
      { name: 'Goblin', kind: 'monster', hpCurrent: 0, deathState: 'none' },
      { name: 'Ember', kind: 'character', hpCurrent: 12, deathState: 'none' },
    ]);
    expect(dead.map((c) => c.name).sort()).toEqual(['Cora', 'Goblin']);
    expect(downed.map((c) => c.name)).toEqual(['Aria']);
    expect(survivors.map((c) => c.name)).toEqual(['Ember']);
  });
});
