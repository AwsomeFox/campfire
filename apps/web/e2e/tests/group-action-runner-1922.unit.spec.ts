import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ActionResolveResult, ActionSpec, ActionUndoToken, Combatant, UsableAction } from '@campfire/schema';
import { ApiError } from '../../src/lib/api';
import {
  findGroupActionCandidates,
  runGroupActionSequence,
  undoGroupActionsInReverseOrder,
  type GroupActionCandidate,
} from '../../src/features/encounters/groupActionRunnerLogic';

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

  test('skips (never errors) an actor whose limited-use pool is exhausted, and keeps going', async () => {
    // Issue #1921 + #1922: the "Run for group" button is gated on the SOURCE row's remaining
    // uses, but each candidate carries its own action_uses entry, so the loop still meets
    // exhausted ones. That must skip, not abort the run.
    const candidates = [candidate(1, 'Goblin 1'), candidate(2, 'Goblin 2'), candidate(3, 'Goblin 3')];
    const outcome = await runGroupActionSequence(candidates, async (c) => {
      if (c.combatantId === 2) throw new ApiError(400, 'no uses left', [], 'action_uses_exhausted');
      return resolveResult(c.combatantId, 'hits');
    });
    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.results.map((r) => r.status)).toEqual(['applied', 'skipped', 'applied']);
    // A DISTINCT reason from a spent action slot: this combatant still HAS its action,
    // the ability is what ran out. The summary card renders a different sentence for each.
    expect(outcome.results[1].reason).toBe('noUses');
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

test.describe('the cross-package contract this runner depends on (issue #1922)', () => {
  // The whole "skipped, never errored" acceptance criterion rests on ONE string literal
  // matching a different one in another package, with nothing forcing them to agree. Every
  // test above constructs its own `ApiError` carrying that literal, so they check the client
  // against itself and would keep passing if the server renamed the code — at which point a
  // spent-slot actor stops being skipped and becomes a loop-STOPPING failure, silently
  // inverting the behavior the issue asks for. Pin it against the server source, the same way
  // `resource-tracker.unit.spec.ts` pins server-side invariants it depends on.
  test('the server still emits the exact code this runner skips on', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../apps/server/src/modules/encounters/action-resolver.service.ts'),
      'utf8',
    );
    // Skipping is only safe because that guard throws BEFORE any target consequence is
    // written (the #1637 convention, "not late-and-unwind"), so the transaction rolls back
    // clean and the actor is genuinely untouched. That property is the server's own
    // invariant and is covered there; what is unguarded — and what this test exists for — is
    // the code string crossing the package boundary.
    expect(src).toContain("code: 'action_economy_exhausted',");
    // Issue #1921 added a SECOND exhaustion code. It has the same silent-inversion risk: if
    // the runner does not skip on it, a pack where one monster already used the ability
    // aborts the whole group run.
    expect(src).toContain("code: 'action_uses_exhausted',");
  });
});
