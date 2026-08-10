import { expect, test } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  mergeOptimisticHpTargets,
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

  test('issue #2119 (P2 follow-up) — merging HP fields preserves a newer per-combatant turnState, not just encounter-level turn fields', () => {
    // The actual hazard, not just the shape: an HP operation is queued against
    // an older `base`. Before the replay writes, a newer encounter snapshot
    // lands — a turn advance that both bumps encounter-level turn fields AND
    // resets combatant #1's OWN turnState (movement/actions used this turn).
    // Replacing the whole combatants array with one recomputed from `base`
    // would silently revert that per-combatant reset; merging must not.
    const base = {
      id: 8,
      currentCombatantId: 1,
      turnVersion: 4,
      round: 1,
      combatants: [
        { ...combatant, hpCurrent: 20, turnState: { used: { action: true }, movementUsedFt: 30 } },
        { id: 2, hpCurrent: 12, hpMax: 20 } as Combatant,
      ],
    } as EncounterWithCombatants;
    const current = {
      ...base,
      currentCombatantId: 2,
      turnVersion: 5,
      round: 2,
      combatants: [
        // A newer snapshot (next-turn seeding) reset #1's turn-owned state —
        // this must survive the merge untouched.
        { ...base.combatants[0], turnState: { used: {}, movementUsedFt: 0 } },
        base.combatants[1],
      ],
    } as EncounterWithCombatants;

    const recomputed = replayOptimisticHpDeltas(base.combatants, [{ combatantId: 1, delta: -5 }]);
    const merged = mergeOptimisticHpTargets(current, recomputed, [1]);

    // The queued HP delta (computed off the stale base) still applies...
    expect(merged.combatants[0]?.hpCurrent).toBe(15);
    // ...but the newer per-combatant turnState from `current` — NOT the one
    // recomputed off `base` — survives. Reverting this assertion to check
    // against `base`'s turnState is exactly the P2: it would prove the bug is
    // back (the whole array replaced with a base-derived one) rather than
    // fixed (only HP-owned fields merged).
    expect(merged.combatants[0]?.turnState).toEqual({ used: {}, movementUsedFt: 0 });
    // ...and the newer encounter-level turn fields survive too (the original
    // #2119 fix, still covered here).
    expect(merged.currentCombatantId).toBe(2);
    expect(merged.turnVersion).toBe(5);
    expect(merged.round).toBe(2);
  });

  test('issue #2119 (P2 follow-up) — a target removed by another client is never resurrected', () => {
    const base = {
      id: 8,
      combatants: [{ ...combatant, hpCurrent: 20 }, { id: 2, hpCurrent: 12, hpMax: 20 } as Combatant],
    } as EncounterWithCombatants;
    // Combatant #1 — who has a queued HP delta against the stale base — was
    // removed by another client before the replay writes.
    const current = { ...base, combatants: [{ id: 2, hpCurrent: 9, hpMax: 20 } as Combatant] } as EncounterWithCombatants;

    const recomputed = replayOptimisticHpDeltas(base.combatants, [{ combatantId: 1, delta: -5 }]);
    const merged = mergeOptimisticHpTargets(current, recomputed, [1]);

    expect(merged.combatants).toHaveLength(1);
    expect(merged.combatants.find((c) => c.id === 1)).toBeUndefined();
    expect(merged.combatants[0]?.hpCurrent).toBe(9);
  });

  test('issue #2119 (P2 follow-up) — a combatant added by another client (never in the stale base) is preserved untouched', () => {
    const base = { id: 8, combatants: [{ ...combatant, hpCurrent: 20 }] } as EncounterWithCombatants;
    const addedByAnotherClient = { id: 99, hpCurrent: 30, hpMax: 30, name: 'Reinforcement' } as Combatant;
    const current = { ...base, combatants: [...base.combatants, addedByAnotherClient] } as EncounterWithCombatants;

    const recomputed = replayOptimisticHpDeltas(base.combatants, [{ combatantId: 1, delta: -5 }]);
    const merged = mergeOptimisticHpTargets(current, recomputed, [1]);

    expect(merged.combatants[0]?.hpCurrent).toBe(15);
    expect(merged.combatants[1]).toBe(addedByAnotherClient);
  });

  test('issue #2119 (third P2 follow-up) — a lone stepper failure rolls back the failed target instead of leaving it stale', () => {
    // Mirrors onError exactly: queue.operations.delete(failedKey) runs BEFORE
    // the replay, so the failed combatant is no longer a live target. Without
    // explicitly re-including it, mergeOptimisticHpTargets's own empty-set
    // guard means the merge is a total no-op and the stale optimistic HP
    // (already written to the cache by onMutate) is never rolled back.
    const base = { id: 8, combatants: [{ ...combatant, hpCurrent: 20 }] } as EncounterWithCombatants;
    // `current` already carries the failed operation's optimistic write (as
    // onMutate's own replay put it there before the request round-tripped).
    const current = { ...base, combatants: [{ ...combatant, hpCurrent: 15 }] } as EncounterWithCombatants;

    // The failed operation was just deleted, so no operations remain at all.
    const remainingOps: { combatantId: number; delta: number }[] = [];
    const recomputed = replayOptimisticHpDeltas(base.combatants, remainingOps);

    // The bug this pins against: deriving targetIds from ONLY the remaining
    // (post-delete) operations, exactly as `1a1a913dc` did.
    const buggyTargetIds = new Set(remainingOps.map((op) => op.combatantId));
    const buggyResult = mergeOptimisticHpTargets(current, recomputed, buggyTargetIds);
    expect(buggyResult.combatants[0]?.hpCurrent).toBe(15); // stale — the bug, reproduced here for contrast

    // The fix: explicitly union the failed operation's own combatant id back
    // in, so its stale HP is merged back to base's (== ctx.previousCombatant's)
    // authoritative pre-operation value.
    const fixedTargetIds = new Set([...remainingOps.map((op) => op.combatantId), combatant.id]);
    const fixedResult = mergeOptimisticHpTargets(current, recomputed, fixedTargetIds);
    expect(fixedResult.combatants[0]?.hpCurrent).toBe(20); // rolled back correctly
  });

  test('issue #2119 (third P2 follow-up) — a cross-target failure rolls back only the failed combatant, other live targets keep their delta', () => {
    const base = {
      id: 8,
      combatants: [{ ...combatant, hpCurrent: 20 }, { id: 2, hpCurrent: 12, hpMax: 20 } as Combatant],
    } as EncounterWithCombatants;
    // Both combatant #1 and #2 have optimistic deltas already applied in the
    // cache (delta -5 and -3 respectively) from onMutate.
    const current = {
      ...base,
      combatants: [{ ...combatant, hpCurrent: 15 }, { id: 2, hpCurrent: 9, hpMax: 20 } as Combatant],
    } as EncounterWithCombatants;

    // Combatant #1's operation just failed and was deleted; #2's operation is
    // still pending.
    const remainingOps = [{ combatantId: 2, delta: -3 }];
    const recomputed = replayOptimisticHpDeltas(base.combatants, remainingOps);

    const buggyTargetIds = new Set(remainingOps.map((op) => op.combatantId)); // {2} — #1 silently dropped
    const buggyResult = mergeOptimisticHpTargets(current, recomputed, buggyTargetIds);
    expect(buggyResult.combatants[0]?.hpCurrent).toBe(15); // stale — #1's failed delta never rolled back
    expect(buggyResult.combatants[1]?.hpCurrent).toBe(9); // #2 unaffected either way

    const fixedTargetIds = new Set([...remainingOps.map((op) => op.combatantId), combatant.id]); // {2, 1}
    const fixedResult = mergeOptimisticHpTargets(current, recomputed, fixedTargetIds);
    expect(fixedResult.combatants[0]?.hpCurrent).toBe(20); // #1 rolled back
    expect(fixedResult.combatants[1]?.hpCurrent).toBe(9); // #2's still-live delta preserved
  });

  test('the HP mutation replays pending deltas instead of restoring a snapshot', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toContain('replayPendingOptimisticHpDeltas');
    expect(source).toContain('optimisticHpQueueRef');
    expect(source).toContain('ctx?.encounterId === eid');
    expect(source).toContain('successful operations stay in');
    expect(source).toContain('turnAdvancePendingRef.current || queryClient.isMutating({ mutationKey: HP_MUTATION_KEY }) > 0 || bulkHpApplyPendingRef.current');
    expect(source).toContain('const hpMutationCount = useIsMutating({ mutationKey: HP_MUTATION_KEY });');
    expect(source).toContain('runControl.isPending || nextTurnMut.isPending || hpMutationCount > 0 || bulkHpApplyPending');
    expect(source).toContain('if (turnAdvancePendingRef.current || bulkHpApplyPendingRef.current) return;');
    expect(source).toMatch(/const nextTurnMut = useKeyedMutation\([\s\S]*?turnAdvancePendingRef\.current = true;[\s\S]*?onSettled: \(\) => \{[\s\S]*?turnAdvancePendingRef\.current = false;/);
    expect(source).toMatch(/const nextTurn = \(\) => \{\s*\/\/[\s\S]*?if \(turnAdvancePendingRef\.current \|\| queryClient\.isMutating\(\{ mutationKey: HP_MUTATION_KEY \}\) > 0 \|\| bulkHpApplyPendingRef\.current\) return;\s*turnAdvancePendingRef\.current = true;\s*nextTurnMut\.mutate/);
    expect(source).toContain('if (!pendingApply || turnAdvancePendingRef.current) return;');
    expect(source).toContain('reconcileBlocks || turnAdvancePendingRef.current');
    expect(source).toContain('rollbackOptimisticHpTargets(current, rollbackBaseline, targets)');
    expect(source).toContain('void invalidateEncounter(queryClient, eid);');
    expect(source).not.toContain('rebaseOptimisticHpEncounter');
    expect(source).not.toContain('rollbackOptimisticHpDelta');
  });

  test('issue #2119 — the HP replay and bulk apply merge HP-owned fields onto the live cache, never replace the whole combatants array', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    // Both writers must route through the narrow helper that merges only
    // HP-owned fields for the touched combatant ids, reading every other
    // field — encounter-level AND per-combatant — from the freshest cache
    // entry rather than a captured `base`/`previous` snapshot. Replacing the
    // whole `combatants` array (even one recomputed off `base`) is exactly
    // the P2 this pins against: it would silently revert a per-combatant
    // field (e.g. `turnState`) another writer set after `base` was captured.
    const replaySite = source.slice(
      source.indexOf('const replayPendingOptimisticHpDeltas = useCallback'),
      source.indexOf('}, [eid, queryClient, ruleSystem, campaign?.customMechanicsProfile]);'),
    );
    expect(replaySite).toContain('mergeOptimisticHpTargets(current, recomputed, targetIds)');
    expect(replaySite).not.toMatch(/setQueryData<EncounterWithCombatants>\(queryKeys\.encounter\(eid\), \{\s*\.\.\.base,/);
    expect(replaySite).not.toContain('withOptimisticHpCombatants');

    const bulkApplySite = source.slice(
      source.indexOf('const applyHpDeltaBulk = useCallback'),
      source.indexOf('const results = await Promise.all(applications.map'),
    );
    expect(bulkApplySite).toContain('mergeOptimisticHpTargets(current, optimisticCombatants, new Set([...targets, ...queuedTargetIds]))');
    expect(bulkApplySite).not.toMatch(/setQueryData<EncounterWithCombatants>\(queryKeys\.encounter\(eid\), \{\s*\.\.\.previous,/);
    expect(bulkApplySite).not.toContain('withOptimisticHpCombatants');

    expect(source).toContain("import {\n  applyOptimisticHpDelta,\n  mergeOptimisticHpTargets,\n  replayOptimisticHpDeltas,\n  rollbackOptimisticHpTargets,\n  type OptimisticHpDelta,\n} from './optimisticHp';");
  });

  test('issue #2119 (third P2 follow-up) — the failed stepper wires its own combatant id into the replay', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');

    expect(source).toContain('const replayPendingOptimisticHpDeltas = useCallback((rolledBackId?: number) => {');
    expect(source).toContain('if (rolledBackId !== undefined) targetIds.add(rolledBackId);');
    // onError must delete the failed operation BEFORE computing targetIds
    // (already true — the replay call happens after the delete) AND pass the
    // failed combatant's own id through, or its stale optimistic HP is never
    // rolled back.
    const onErrorStart = source.indexOf('onError: (err, vars, ctx) => {');
    const onErrorSite = source.slice(
      onErrorStart,
      source.indexOf("if (isAmbiguousOutcome(err)) enterReconciling();\n      else reportError(err);", onErrorStart),
    );
    expect(onErrorSite).toContain('queue.operations.delete(ctx.optimisticOperationId)');
    expect(onErrorSite).toContain('replayPendingOptimisticHpDeltas(vars.combatantId)');
    // The delete must run BEFORE the replay call, not after — the replay's
    // `targetIds` are derived from whatever remains in `queue.operations` at
    // call time.
    expect(onErrorSite.indexOf('queue.operations.delete(ctx.optimisticOperationId)'))
      .toBeLessThan(onErrorSite.indexOf('replayPendingOptimisticHpDeltas(vars.combatantId)'));
  });
});
