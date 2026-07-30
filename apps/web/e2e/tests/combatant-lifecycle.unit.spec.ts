import { expect, test } from '@playwright/test';
import type { Combatant } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canStabilizeCombatant,
  hasRestoredTrashedEncounter,
  isCurrentCombatantUndoEncounter,
  REMOVE_COMBATANT_CONFIRM_BODY,
  withOptimisticHpLifecycle,
} from '../../src/features/encounters/combatantLifecycle';
import { applyOptimisticHpDelta } from '../../src/features/encounters/optimisticHp';

function combatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 1,
    encounterId: 1,
    kind: 'character',
    characterId: 1,
    npcId: null,
    name: 'Ari',
    initiative: 12,
    initMod: 2,
    initiativeBreakdown: null,
    initiativeGroup: null,
    hpCurrent: 5,
    hpMax: 10,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    eac: null,
    kac: null,
    hpTemp: 0,
    hpBand: null,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    ruleEntryId: null,
    sortOrder: 0,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: {
      used: {},
      movementUsedFt: 0,
      concentration: null,
      pendingConcentrationChecks: [],
      delaying: false,
      readied: null,
    },
    activeEffects: [],
    conditionInstances: [],
    legendaryActions: null,
    statblock: null,
    ...overrides,
  };
}

test.describe('combatant lifecycle (issue #1469)', () => {
  test('only a character at 0 HP, or an adapter-persisted dying creature, can stabilize', () => {
    expect(canStabilizeCombatant(combatant({ hpCurrent: 0 }))).toBe(true);
    expect(canStabilizeCombatant(combatant({ kind: 'monster', characterId: null, hpCurrent: 0 }))).toBe(false);
    expect(canStabilizeCombatant(combatant({ kind: 'monster', characterId: null, hpCurrent: 0, deathState: 'dying' }))).toBe(true);
  });

  test('damage to 0 HP immediately renders a character as dying', () => {
    expect(applyOptimisticHpDelta(combatant(), -5)).toMatchObject({
      hpCurrent: 0,
      deathState: 'dying',
    });
  });

  test('damage to an already-dead character keeps it dead optimistically', () => {
    expect(withOptimisticHpLifecycle(combatant({ hpCurrent: 0, deathState: 'dead' }), 0)).toMatchObject({
      hpCurrent: 0,
      deathState: 'dead',
    });
  });

  test('temporary HP that absorbs damage preserves a stabilized character', () => {
    expect(
      withOptimisticHpLifecycle(combatant({ hpCurrent: 0, hpTemp: 4, deathState: 'stable' }), 0, false),
    ).toMatchObject({
      hpCurrent: 0,
      deathState: 'stable',
    });
  });

  test('healing clears optimistic death pips', () => {
    expect(
      applyOptimisticHpDelta(
        combatant({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 2, deathSaveFailures: 1 }),
        1,
      ),
    ).toMatchObject({
      hpCurrent: 1,
      deathState: 'none',
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
    });
  });

  test('Starfinder keeps its adapter-derived death state', () => {
    const source = readFileSync(resolve(__dirname, '../../src/features/encounters/optimisticHp.ts'), 'utf8');
    expect(source).toContain('hpCurrent: sfResult.hpCurrent');
    expect(source).toContain('deathState: sfResult.deathState');
    expect(source).not.toContain('}, sfResult.hpCurrent);');
  });

  test('remove copy names the lost state and immediate undo recovery', () => {
    expect(REMOVE_COMBATANT_CONFIRM_BODY).toContain('HP, conditions, initiative, and turn state');
    expect(REMOVE_COMBATANT_CONFIRM_BODY).toContain('undo it immediately');
  });

  test('a changed encounter revision proves restoration only after a post-trash 404', () => {
    expect(hasRestoredTrashedEncounter('before-trash', false, 'late-pre-trash-read')).toBe(false);
    expect(hasRestoredTrashedEncounter('before-trash', true, 'after-restore')).toBe(true);
  });

  test('replacement undo tokens remount, survive older undo completions, and cannot cross encounter routes', () => {
    const source = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toContain('key={pendingCombatantUndo.undoToken}');
    expect(source).toContain('pendingCombatantUndo.encounterId !== eid');
    expect(source).toContain('setPendingCombatantUndo(null);');
    expect(source).toContain('pending?.undoToken === undoToken ? null : pending');
    expect(isCurrentCombatantUndoEncounter(11, 11)).toBe(true);
    expect(isCurrentCombatantUndoEncounter(11, 12)).toBe(false);
    expect(source).toContain('activeEncounterIdRef.current');
    expect(source).toContain('requestEncounterId = eid');
    expect(source).toContain('requestEncounterId = pendingCombatantUndo.encounterId');
    expect(source).toContain('if (isCurrentCombatantUndoEncounter(requestEncounterId, activeEncounterIdRef.current)) reportError(err);');
    expect(source).toContain('setPendingCombatantIds(new Set());');
    expect(source).toContain('setPendingCombatantUndo(null);');
    expect(source).toContain('trashedEncounterIdsRef.current.has(requestEncounterId)');
    expect(source).toContain('dismissCompetingRecoveryUndos();');
    expect(source).toContain('trashedEncounterIdsRef.current.add(encounterId);');
    expect(source).toContain("snapshot?.name ?? 'Combatant'");
    expect(source).toContain('const combatantRemovalKeys = useRef(new Map<string, string>());');
    expect(source).toContain('const idempotencyKey = combatantRemovalKeys.current.get(removalKey) ?? newOperationId();');
    expect(source).toContain('.delete<CombatantRemoveResult>');
    expect(source).toContain('{ json: { idempotencyKey } }');
    expect(source).toContain('if (!isTransientError(error)) combatantRemovalKeys.current.delete(removalKey);');
    expect(source).toContain('mutationFn: ({ encounterId }: { encounterId: number; updatedAt?: string })');
    expect(source).toContain('if (encounterId === activeEncounterIdRef.current)');
    expect(source).toContain('const sourceEncounterId = pendingTrashUndo?.encounterId;');
    expect(source).toContain('!isCurrentCombatantUndoEncounter(eid, activeEncounterIdRef.current) || trashedEncounterIdsRef.current.has(eid)');
    expect(source).toContain('if (onBeginTokenBatchUndo?.() === false) return;');
    expect(source).toContain('dismissTokenUndoNonce={dismissTokenUndoNonce}');
    expect(source).toContain('onBeginTokenBatchUndo={dismissRecoveryUndosForTokenBatch}');
    expect(source).toContain('beginTokenBatchUndo(result.undoToken)');
  });
});
