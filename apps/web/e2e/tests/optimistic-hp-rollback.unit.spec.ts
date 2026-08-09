import { expect, test } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  rebaseOptimisticHpEncounter,
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

  test('rebases pending HP operations onto a newer turn without double-applying them', () => {
    const base = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      combatants: [combatant, { id: 2, hpCurrent: 12, hpMax: 20 } as Combatant],
    } as EncounterWithCombatants;
    const advanced = {
      ...base,
      currentCombatantId: 2,
      turnVersion: 5,
      combatants: [
        { ...combatant, hpCurrent: 15 },
        { id: 2, hpCurrent: 9, hpMax: 20 } as Combatant,
      ],
    };
    const operations = [{ combatantId: 1, delta: -5 }];

    const rebased = rebaseOptimisticHpEncounter(base, advanced, operations);
    const replayed = replayOptimisticHpDeltas(rebased.combatants, operations);

    expect(rebased.currentCombatantId).toBe(2);
    expect(rebased.turnVersion).toBe(5);
    expect(replayed.find(({ id }) => id === 1)?.hpCurrent).toBe(15);
    expect(replayed.find(({ id }) => id === 2)?.hpCurrent).toBe(9);
  });

  test('the HP mutation replays pending deltas instead of restoring a snapshot', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toContain('replayPendingOptimisticHpDeltas');
    expect(source).toContain('optimisticHpQueueRef');
    expect(source).toContain('ctx?.encounterId === eid');
    expect(source).toContain('successful operations stay in');
    expect(source).toContain('hpQueue.base = rebaseOptimisticHpEncounter');
    expect(source).toMatch(/hpQueue\.base = rebaseOptimisticHpEncounter\([\s\S]*?replayPendingOptimisticHpDeltas\(\);/);
    expect(source).not.toContain('rollbackOptimisticHpDelta');
  });
});
