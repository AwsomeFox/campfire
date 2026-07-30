import { expect, test } from '@playwright/test';
import type { Combatant } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  replayOptimisticHpDeltas,
} from '../../src/features/encounters/optimisticHp';

const combatant = { id: 1, hpCurrent: 20, hpMax: 20 } as Combatant;
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('optimistic HP rollback (issue #1754)', () => {
  test('failed burst mutations replay the remaining deltas in either failure order', () => {
    const operations = [
      { combatantId: 1, delta: -5 },
      { combatantId: 1, delta: -3 },
    ];

    const firstMutationFailsFirst = replayOptimisticHpDeltas([combatant], [operations[1]!]);
    const secondMutationFailsAfterFirst = replayOptimisticHpDeltas([combatant], []);
    const secondMutationFailsFirst = replayOptimisticHpDeltas([combatant], [operations[0]!]);
    const firstMutationFailsAfterSecond = replayOptimisticHpDeltas([combatant], []);

    expect(firstMutationFailsFirst[0]!.hpCurrent).toBe(17);
    expect(secondMutationFailsAfterFirst[0]!.hpCurrent).toBe(20);
    expect(secondMutationFailsFirst[0]!.hpCurrent).toBe(15);
    expect(firstMutationFailsAfterSecond[0]!.hpCurrent).toBe(20);
  });

  test('replaying around a capped heal preserves the remaining damage', () => {
    const afterFailedHeal = replayOptimisticHpDeltas([combatant], [{ combatantId: 1, delta: -3 }]);

    expect(afterFailedHeal[0]!.hpCurrent).toBe(17);
  });

  test('the HP mutation replays pending deltas instead of restoring a snapshot', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toContain('replayPendingOptimisticHpDeltas');
    expect(source).toContain('optimisticHpQueueRef');
    expect(source).toContain('ctx?.encounterId === eid');
    expect(source).toContain('successful operations stay in');
    expect(source).not.toContain('rollbackOptimisticHpDelta');
  });
});
