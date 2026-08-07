import { expect, test } from '@playwright/test';
import type { ActionResolveResult, ActionSpec, ActionUndoToken, Combatant, UsableAction } from '@campfire/schema';
import { ApiError } from '../../src/lib/api';
import {
  findGroupActionCandidates,
  runGroupActionSequence,
  undoGroupActionsInReverseOrder,
  type GroupActionCandidate,
} from '../../src/features/encounters/groupActionRunner';

const SPEC: ActionSpec = {
  mode: 'attack',
  attack: { bonus: '', ability: '', proficient: true, vs: 'ac' },
  save: { ability: '', dc: { kind: 'none', dc: 10, ability: '', proficient: true, bonus: 0, base: 8 } },
  cost: { slot: 'action', count: 1 },
  uses: { max: 0, recharge: '', concentration: false, repeatSave: false, spellLevel: 0, resourceKey: '', resourceCost: 0 },
  range: { range: '', shape: '', size: '' },
  targets: { count: 1, allow: 'enemy' },
  outcomes: {},
  provenance: { ruleSystem: '', source: '', ref: '' },
};

function combatant(overrides: Partial<Combatant> & { id: number; name: string }): Combatant {
  return {
    encounterId: 1,
    kind: 'monster',
    characterId: null,
    npcId: null,
    initiative: null,
    initMod: 0,
    initiativeBreakdown: null,
    initiativeGroup: null,
    hpCurrent: 10,
    hpMax: 10,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    eac: null,
    kac: null,
    speed: null,
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
    turnState: { used: {}, movementUsedFt: 0, concentration: null, pendingConcentrationChecks: [], delaying: false, readied: null },
    ...overrides,
  } as unknown as Combatant;
}

function usableAction(overrides: Partial<UsableAction> & { index: number; name: string }): UsableAction {
  return {
    kind: '',
    mode: 'attack',
    toHit: '+4',
    damage: '1d6+2',
    notes: '',
    resolvable: true,
    spec: SPEC,
    source: '',
    ...overrides,
  } as UsableAction;
}

test.describe('findGroupActionCandidates (issue #1922 — eligibility)', () => {
  test('matches other living combatants sharing the actor ruleEntryId', () => {
    const combatants = [
      combatant({ id: 1, name: 'Goblin 1', ruleEntryId: 55 }),
      combatant({ id: 2, name: 'Goblin 2', ruleEntryId: 55 }),
      combatant({ id: 3, name: 'Goblin 3', ruleEntryId: 55 }),
      combatant({ id: 4, name: 'Orc', ruleEntryId: 99 }),
    ];
    const actions = new Map<number, UsableAction[]>([
      [2, [usableAction({ index: 0, name: 'Shortbow' })]],
      [3, [usableAction({ index: 0, name: 'Shortbow' })]],
      [4, [usableAction({ index: 0, name: 'Greataxe', toHit: '+6', damage: '1d12+4' })]],
    ]);
    const result = findGroupActionCandidates({
      combatants,
      actorCombatantId: 1,
      sourceAction: { name: 'Shortbow', toHit: '+4', damage: '1d6+2' },
      actionsByCombatantId: actions,
    });
    expect(result.map((c) => c.combatantId).sort()).toEqual([2, 3]);
  });

  test('matches an identical action fingerprint (name+toHit+damage) even without a shared ruleEntryId', () => {
    const combatants = [
      combatant({ id: 1, name: 'Homebrew Goblin A', ruleEntryId: null }),
      combatant({ id: 2, name: 'Homebrew Goblin B', ruleEntryId: null }),
      combatant({ id: 3, name: 'Different Monster', ruleEntryId: null }),
    ];
    const actions = new Map<number, UsableAction[]>([
      [2, [usableAction({ index: 3, name: 'Shortbow', toHit: '+4', damage: '1d6+2' })]],
      [3, [usableAction({ index: 0, name: 'Shortbow', toHit: '+2', damage: '1d4' })]],
    ]);
    const result = findGroupActionCandidates({
      combatants,
      actorCombatantId: 1,
      sourceAction: { name: 'Shortbow', toHit: '+4', damage: '1d6+2' },
      actionsByCombatantId: actions,
    });
    expect(result).toEqual([
      { combatantId: 2, combatantName: 'Homebrew Goblin B', actionIndex: 3, actionName: 'Shortbow', spec: SPEC },
    ]);
  });

  test('excludes dead combatants (deathState dead, or a downed monster/npc)', () => {
    const combatants = [
      combatant({ id: 1, name: 'Goblin 1', ruleEntryId: 55 }),
      combatant({ id: 2, name: 'Goblin 2 (dead)', ruleEntryId: 55, deathState: 'dead' }),
      combatant({ id: 3, name: 'Goblin 3 (down)', ruleEntryId: 55, hpCurrent: 0 }),
      combatant({ id: 4, name: 'Goblin 4 (alive)', ruleEntryId: 55 }),
    ];
    const actions = new Map<number, UsableAction[]>([
      [2, [usableAction({ index: 0, name: 'Shortbow' })]],
      [3, [usableAction({ index: 0, name: 'Shortbow' })]],
      [4, [usableAction({ index: 0, name: 'Shortbow' })]],
    ]);
    const result = findGroupActionCandidates({
      combatants,
      actorCombatantId: 1,
      sourceAction: { name: 'Shortbow', toHit: '+4', damage: '1d6+2' },
      actionsByCombatantId: actions,
    });
    expect(result.map((c) => c.combatantId)).toEqual([4]);
  });

  test('excludes a candidate whose own action list has not been fetched yet', () => {
    const combatants = [
      combatant({ id: 1, name: 'Goblin 1', ruleEntryId: 55 }),
      combatant({ id: 2, name: 'Goblin 2', ruleEntryId: 55 }),
    ];
    const result = findGroupActionCandidates({
      combatants,
      actorCombatantId: 1,
      sourceAction: { name: 'Shortbow', toHit: '+4', damage: '1d6+2' },
      actionsByCombatantId: new Map(),
    });
    expect(result).toEqual([]);
  });

  test('excludes a linked character combatant even if it happens to share the ruleEntryId shape', () => {
    const combatants = [
      combatant({ id: 1, name: 'Goblin 1', ruleEntryId: 55 }),
      combatant({ id: 2, name: 'Player', kind: 'character', characterId: 9, ruleEntryId: 55 }),
    ];
    const actions = new Map<number, UsableAction[]>([[2, [usableAction({ index: 0, name: 'Shortbow' })]]]);
    const result = findGroupActionCandidates({
      combatants,
      actorCombatantId: 1,
      sourceAction: { name: 'Shortbow', toHit: '+4', damage: '1d6+2' },
      actionsByCombatantId: actions,
    });
    expect(result).toEqual([]);
  });
});

function candidate(id: number, name: string): GroupActionCandidate {
  return { combatantId: id, combatantName: name, actionIndex: 0, actionName: 'Shortbow', spec: SPEC };
}

function undoToken(actorCombatantId: number): ActionUndoToken {
  return {
    encounterId: 1,
    actorCombatantId,
    actionName: 'Shortbow',
    chainId: `chain-${actorCombatantId}`,
    targets: [],
    costSlot: 'action',
    costCount: 1,
    spellLevelSpent: 0,
    concentrationBefore: null,
    pendingConcentrationChecksBefore: [],
    startedConcentration: false,
  };
}

function resolveResult(actorCombatantId: number, summary: string): ActionResolveResult {
  return {
    resolution: {
      actorCombatantId,
      actorName: `Goblin ${actorCombatantId}`,
      actionName: 'Shortbow',
      mode: 'attack',
      playerSummary: summary,
      dmSummary: summary,
      targets: [],
      costSlot: 'action',
      costCount: 1,
      usesSpent: 0,
      spellLevelSpent: 0,
      startsConcentration: false,
    },
    applied: true,
    canApply: true,
    policy: 'automatic',
    undoToken: undoToken(actorCombatantId),
    chainId: `chain-${actorCombatantId}`,
    systemMathSupported: true,
    mathProfile: null,
  };
}

test.describe('runGroupActionSequence (issue #1922 — the sequential loop)', () => {
  test('skips (never errors) an actor whose action-economy slot is already spent, and keeps going', async () => {
    const candidates = [candidate(1, 'Goblin 1'), candidate(2, 'Goblin 2'), candidate(3, 'Goblin 3')];
    const outcome = await runGroupActionSequence(candidates, async (c) => {
      if (c.combatantId === 2) {
        throw new ApiError(400, 'no action left', [], 'action_economy_exhausted');
      }
      return resolveResult(c.combatantId, `${c.combatantName} hits`);
    });
    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.results.map((r) => r.status)).toEqual(['applied', 'skipped', 'applied']);
    expect(outcome.results[1].reason).toBe('noAction');
  });

  test('a mid-loop non-economy failure stops the loop and reports applied vs not-run', async () => {
    const candidates = [candidate(1, 'Goblin 1'), candidate(2, 'Goblin 2'), candidate(3, 'Goblin 3'), candidate(4, 'Goblin 4')];
    const outcome = await runGroupActionSequence(candidates, async (c) => {
      if (c.combatantId === 3) {
        throw new ApiError(500, 'server exploded');
      }
      return resolveResult(c.combatantId, `${c.combatantName} hits`);
    });
    expect(outcome.stoppedEarly).toBe(true);
    expect(outcome.results.map((r) => r.status)).toEqual(['applied', 'applied', 'failed', 'not-run']);
  });

  test('applies every candidate when nothing fails', async () => {
    const candidates = [candidate(1, 'Goblin 1'), candidate(2, 'Goblin 2')];
    const outcome = await runGroupActionSequence(candidates, async (c) => resolveResult(c.combatantId, `${c.combatantName} hits`));
    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.results.every((r) => r.status === 'applied')).toBe(true);
    expect(outcome.results.map((r) => r.undoToken?.actorCombatantId)).toEqual([1, 2]);
  });
});

test.describe('undoGroupActionsInReverseOrder (issue #1922 — Undo all)', () => {
  test('replays undo tokens in REVERSE apply order', async () => {
    const tokens = [undoToken(1), undoToken(2), undoToken(3)];
    const calledOrder: number[] = [];
    const outcome = await undoGroupActionsInReverseOrder(tokens, async (t) => {
      calledOrder.push(t.actorCombatantId);
    });
    expect(calledOrder).toEqual([3, 2, 1]);
    expect(outcome).toEqual({ undoneCount: 3, failed: false });
  });

  test('stops on the first failed undo and reports how many succeeded', async () => {
    const tokens = [undoToken(1), undoToken(2), undoToken(3)];
    const calledOrder: number[] = [];
    const outcome = await undoGroupActionsInReverseOrder(tokens, async (t) => {
      calledOrder.push(t.actorCombatantId);
      if (t.actorCombatantId === 2) throw new Error('undo failed');
    });
    // 3 undone first (succeeds), then 2 attempted and fails — 1 is never reached.
    expect(calledOrder).toEqual([3, 2]);
    expect(outcome).toEqual({ undoneCount: 1, failed: true });
  });
});
