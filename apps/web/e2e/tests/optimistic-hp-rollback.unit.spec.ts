import { expect, test } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  rebaseOptimisticHpEncounter,
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

  test('rebases pending HP operations onto a newer turn without double-applying them', () => {
    const base = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      combatants: [{
        ...combatant,
        turnState: {
          used: { action: 1 },
          movementUsedFt: 20,
          concentration: null,
          pendingConcentrationChecks: [],
          delaying: false,
          readied: null,
        },
      }, { id: 2, hpCurrent: 12, hpMax: 20 } as Combatant],
    } as EncounterWithCombatants;
    const advanced = {
      ...base,
      currentCombatantId: 2,
      turnVersion: 5,
      combatants: [
        {
          ...combatant,
          hpCurrent: 15,
          turnState: {
            used: {},
            movementUsedFt: 0,
            concentration: null,
            pendingConcentrationChecks: [],
            delaying: false,
            readied: null,
          },
        },
        { id: 2, hpCurrent: 9, hpMax: 20 } as Combatant,
      ],
    };
    const operations = [{ combatantId: 1, delta: -5, reflected: true }];

    const rebased = rebaseOptimisticHpEncounter(base, advanced, operations);
    const replayed = replayOptimisticHpDeltas(rebased.combatants, operations);

    expect(rebased.currentCombatantId).toBe(2);
    expect(rebased.turnVersion).toBe(5);
    expect(rebased.combatants.find(({ id }) => id === 1)?.turnState).toEqual(advanced.combatants[0]?.turnState);
    expect(replayed.find(({ id }) => id === 1)?.hpCurrent).toBe(15);
    expect(replayed.find(({ id }) => id === 2)?.hpCurrent).toBe(9);
  });

  test('retains a concurrent server HP change while rebasing a pending delta', () => {
    const base = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      combatants: [combatant],
    } as EncounterWithCombatants;
    // The newer snapshot includes both another client's -3 and this client's
    // still-ledgered -5. Replaying must retain the -3 without applying -5 twice.
    const advanced = {
      ...base,
      currentCombatantId: 2,
      turnVersion: 5,
      combatants: [{ ...combatant, hpCurrent: 12 }],
    } as EncounterWithCombatants;
    const operations = [{ combatantId: 1, delta: -5, reflected: true }];

    const rebased = rebaseOptimisticHpEncounter(base, advanced, operations);
    const replayed = replayOptimisticHpDeltas(rebased.combatants, operations);

    expect(rebased.combatants[0]?.hpCurrent).toBe(17);
    expect(replayed[0]?.hpCurrent).toBe(12);
    expect(replayOptimisticHpDeltas(rebased.combatants, [])[0]?.hpCurrent).toBe(17);
  });

  test('does not subtract a pending delta that the newer turn has not reflected', () => {
    const base = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      combatants: [combatant],
    } as EncounterWithCombatants;
    const advanced = {
      ...base,
      currentCombatantId: 2,
      turnVersion: 5,
    };
    const operations = [{ combatantId: 1, delta: -5, reflected: false }];

    const rebased = rebaseOptimisticHpEncounter(base, advanced, operations);
    const replayed = replayOptimisticHpDeltas(rebased.combatants, operations);

    expect(rebased.combatants[0]?.hpCurrent).toBe(20);
    expect(replayed[0]?.hpCurrent).toBe(15);
    expect(replayOptimisticHpDeltas(rebased.combatants, [])[0]?.hpCurrent).toBe(20);
  });

  test('retains the concurrent lifecycle baseline when combined damage crosses zero', () => {
    const baseCombatant = {
      ...combatant,
      kind: 'character' as const,
      hpCurrent: 10,
      deathState: 'none' as const,
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
    };
    const base = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      combatants: [baseCombatant],
    } as EncounterWithCombatants;
    const advanced = {
      ...base,
      currentCombatantId: 2,
      turnVersion: 5,
      combatants: [{ ...baseCombatant, hpCurrent: 0, deathState: 'dying' as const }],
    } as EncounterWithCombatants;
    const operations = [{ combatantId: 1, delta: -5, reflected: true }];

    const rebased = rebaseOptimisticHpEncounter(base, advanced, operations);
    const replayed = replayOptimisticHpDeltas(rebased.combatants, operations);

    expect(rebased.combatants[0]).toMatchObject({ hpCurrent: 5, deathState: 'none' });
    expect(replayed[0]).toMatchObject({ hpCurrent: 0, deathState: 'dying' });
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
    expect(source).toContain('reflected: false');
    expect(source).toContain('operation.reflected = true');
    expect(source).toContain('rollbackOptimisticHpTargets(current, previous, targets)');
    expect(source).toContain('void invalidateEncounter(queryClient, eid);');
    expect(source).toContain('hpQueue.base = rebaseOptimisticHpEncounter');
    expect(source).toMatch(/hpQueue\.base = rebaseOptimisticHpEncounter\([\s\S]*?replayPendingOptimisticHpDeltas\(\);/);
    expect(source).not.toContain('rollbackOptimisticHpDelta');
  });
});
