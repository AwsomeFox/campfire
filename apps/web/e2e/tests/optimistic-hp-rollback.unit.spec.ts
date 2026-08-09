import { expect, test } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  replayOptimisticHpDeltas,
  rollbackOptimisticHpTargets,
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

  test('bulk HP rollback preserves a newer seeded turn', () => {
    const beforeTarget = { ...combatant, hpCurrent: 20 };
    const previous = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      combatants: [beforeTarget, { id: 2, hpCurrent: 12, hpMax: 20 } as Combatant],
    } as EncounterWithCombatants;
    const current = {
      ...previous,
      currentCombatantId: 2,
      turnVersion: 5,
      combatants: [
        { ...beforeTarget, hpCurrent: 15, turnState: { used: {}, movementUsedFt: 0 } },
        { id: 2, hpCurrent: 9, hpMax: 20 } as Combatant,
      ],
    } as EncounterWithCombatants;

    const restored = rollbackOptimisticHpTargets(current, previous, [1]);

    expect(restored.currentCombatantId).toBe(2);
    expect(restored.turnVersion).toBe(5);
    expect(restored.combatants[0]).toMatchObject({ hpCurrent: 20, turnState: current.combatants[0]?.turnState });
    expect(restored.combatants[1]?.hpCurrent).toBe(9);
  });

  test('the HP mutation replays pending deltas instead of restoring a snapshot', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toContain('replayPendingOptimisticHpDeltas');
    expect(source).toContain('optimisticHpQueueRef');
    expect(source).toContain('ctx?.encounterId === eid');
    expect(source).toContain('successful operations stay in');
    expect(source).toContain('queryClient.isMutating({ mutationKey: HP_MUTATION_KEY }) > 0 || bulkHpApplyPendingRef.current');
    expect(source).toContain('runControl.isPending || nextTurnMut.isPending || hpDelta.isPending || bulkHpApplyPending');
    expect(source).toMatch(/const nextTurnMut = useKeyedMutation\([\s\S]*?turnAdvancePendingRef\.current = true;[\s\S]*?onSettled: \(\) => \{[\s\S]*?turnAdvancePendingRef\.current = false;/);
    expect(source).toContain('if (!pendingApply || turnAdvancePendingRef.current) return;');
    expect(source).toContain('reconcileBlocks || turnAdvancePendingRef.current');
    expect(source).toContain('rollbackOptimisticHpTargets(current, rollbackBaseline, targets)');
    expect(source).toContain('void invalidateEncounter(queryClient, eid);');
    expect(source).not.toContain('rebaseOptimisticHpEncounter');
    expect(source).not.toContain('rollbackOptimisticHpDelta');
  });
});
