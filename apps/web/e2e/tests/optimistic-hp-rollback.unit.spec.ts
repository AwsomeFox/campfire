import { expect, test } from '@playwright/test';
import type { Combatant } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyOptimisticHpDelta,
  rollbackOptimisticHpDelta,
} from '../../src/features/encounters/optimisticHp';

const combatant = { id: 1, hpCurrent: 20, hpMax: 20 } as Combatant;
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('optimistic HP rollback (issue #1754)', () => {
  test('failed burst mutations revert their own deltas in either failure order', () => {
    const afterBurst = applyOptimisticHpDelta(applyOptimisticHpDelta(combatant, -5), -3);

    const firstMutationFailsFirst = rollbackOptimisticHpDelta(
      rollbackOptimisticHpDelta(afterBurst, -5),
      -3,
    );
    const secondMutationFailsFirst = rollbackOptimisticHpDelta(
      rollbackOptimisticHpDelta(afterBurst, -3),
      -5,
    );

    expect(firstMutationFailsFirst.hpCurrent).toBe(20);
    expect(secondMutationFailsFirst.hpCurrent).toBe(20);
  });

  test('the HP mutation rolls back its own delta instead of restoring a snapshot', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toContain('ctx?.appliedOptimisticDelta');
    expect(source).toContain('rollbackOptimisticHpDelta(c, delta, ruleSystem)');
    expect(source).not.toContain('ctx?.previous');
  });
});
