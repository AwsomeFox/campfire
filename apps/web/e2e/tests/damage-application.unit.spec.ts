import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiceRoll } from '@campfire/schema';
import { reliableDiceSubtotal } from '../../src/components/RollResultToastContext';
import {
  buildAoeDamageApplications,
  normalizeDirectDamageType,
} from '../../src/features/encounters/directDamage';

function diceRoll(partial: Partial<DiceRoll>): DiceRoll {
  return {
    id: 1,
    campaignId: 1,
    rollerUserId: 'test',
    rollerName: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    expr: '2d6',
    rolls: [3, 4],
    total: 7,
    ...partial,
  };
}

test.describe('direct damage apply controls (issue #605)', () => {
  test('critical subtotal uses signed dice terms and excludes flat modifiers', () => {
    expect(reliableDiceSubtotal(diceRoll({
      expr: '2d6-1d4+3',
      total: 7,
      terms: [
        { term: '2d6', value: 9, rolls: [4, 5] },
        { term: '-1d4', value: -5, rolls: [5] },
        { term: '+3', value: 3 },
      ],
    }))).toBe(4);
  });

  test('does not manufacture a critical dice subtotal for physical/manual totals', () => {
    expect(reliableDiceSubtotal(diceRoll({ source: 'manual', expr: 'physical', rolls: [], total: 17 }))).toBeUndefined();
    expect(reliableDiceSubtotal(diceRoll({ expr: '+3', rolls: [], total: 3, terms: [{ term: '+3', value: 3 }] }))).toBeUndefined();
  });

  test('does not expose nonpositive signed dice subtotals for critical application', () => {
    expect(reliableDiceSubtotal(diceRoll({
      expr: '1d4-1d6+10',
      total: 5,
      terms: [
        { term: '1d4', value: 1, rolls: [1] },
        { term: '-1d6', value: -6, rolls: [6] },
        { term: '+10', value: 10 },
      ],
    }))).toBeUndefined();
    expect(reliableDiceSubtotal(diceRoll({
      expr: '1d6-1d6+4',
      total: 4,
      terms: [
        { term: '1d6', value: 3, rolls: [3] },
        { term: '-1d6', value: -3, rolls: [3] },
        { term: '+4', value: 4 },
      ],
    }))).toBeUndefined();
  });

  test('normalizes free-form damage types before building API metadata', () => {
    expect(normalizeDirectDamageType('  fire  ')).toBe('fire');
    expect(normalizeDirectDamageType('   ')).toBeUndefined();
  });

  test('gates damage controls and metadata on the adapter capability', () => {
    const source = [
      readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx'), 'utf8'),
    ].join('\n');
    expect(source).toContain('supportsDirectDamageRules === true');
    expect(source).toContain("mode === 'damage' && supportsDamageRules");
    expect(source).toContain('disabled={diceTotal === undefined}');
    expect(source).toContain('key={pendingApply.id}');
  });

  test('builds independent save outcomes for targets in one AoE apply', () => {
    expect(buildAoeDamageApplications(
      [11, 22],
      { damageType: 'fire', isCrit: true, damageDice: 6 },
      'full',
      { 22: 'half' },
    )).toEqual([
      { combatantId: 11, damage: { damageType: 'fire', isCrit: true, damageDice: 6 } },
      { combatantId: 22, damage: { damageType: 'fire', isCrit: true, damageDice: 6, saveOutcome: 'half' } },
    ]);
  });
});
