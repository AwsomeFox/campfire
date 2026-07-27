import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiceRoll } from '@campfire/schema';
import { reliableDiceSubtotal } from '../../src/components/RollResultToastContext';

const ROOT = resolve(__dirname, '../..');

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

  test('gates damage controls and metadata on the adapter capability', () => {
    const source = readFileSync(resolve(ROOT, 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toContain('supportsDirectDamageRules === true');
    expect(source).toContain("mode === 'damage' && supportsDamageRules");
    expect(source).toContain('disabled={diceTotal === undefined}');
    expect(source).toContain('key={pendingApply.id}');
  });
});
