import {
  ActionEconomySlot,
  ActiveEffect,
  Combatant,
  CombatantTurnState,
  DND5E_ACTION_ECONOMY,
  EMPTY_TURN_STATE,
  actionEconomyForAdapter,
  listRuleSystemAdapters,
} from '@campfire/schema';
import {
  advanceTurn,
  cascadeConcentrationLoss,
  deriveEndTurnPrompts,
  deriveStartTurnPrompts,
  resetTurnStateForStart,
  retreatTurn,
  tickConditionInstancesAtTurnEnd,
  tickConditionInstancesAtTurnStart,
  tickEffectsAtTurnEnd,
} from '../../src/modules/encounters/encounters.logic';

/**
 * Issue #413 — pure current-turn-workspace logic. These functions are the deterministic
 * heart of the turn workspace (undo, per-turn reset, effect ticking, prompt derivation),
 * unit-tested without a DB so the behavior is pinned independent of the service wiring.
 */

/** Minimal running combatant for the ordering helpers (only id/initiative/sortOrder matter). */
function combatant(id: number, initiative: number, sortOrder = id): Combatant {
  return {
    id,
    encounterId: 1,
    kind: 'monster',
    characterId: null,
    npcId: null,
    name: `C${id}`,
    initiative,
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
    sortOrder,
    manualOrder: null,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: { ...EMPTY_TURN_STATE, used: { ...EMPTY_TURN_STATE.used } },
    activeEffects: [],
    conditionInstances: [],
    legendaryActions: null,
    statblock: null,
    statblockRevealed: false,
  };
}

describe('adapter action economy (issue #413)', () => {
  it.each(listRuleSystemAdapters().map((a) => [a.id, a] as const))(
    '%s adapter provides defined action economy model',
    (id, adapter) => {
      const model = actionEconomyForAdapter(adapter);
      expect(model.slots.length).toBeGreaterThan(0);
      if (id === 'dnd5e') {
        expect(model.slots.map((s) => s.key)).toEqual(['action', 'bonus', 'reaction', 'movement']);
        expect(model).toBe(DND5E_ACTION_ECONOMY);
      } else if (id === 'pf2e' || id === 'sf2e') {
        expect(model.slots.map((s) => s.key)).toEqual(['actions', 'reaction']);
        expect(model.slots.find((s) => s.key === 'actions')?.max).toBe(3);
      } else {
        expect(model.slots).toHaveLength(1);
        expect(model.slots[0].key).toBe('action');
      }
    },
  );
});

describe('retreatTurn (undo advance, issue #413)', () => {
  const sorted = [combatant(1, 20), combatant(2, 15), combatant(3, 10)];

  it('reverses advanceTurn within a round', () => {
    // Forward: c1 -> c2. Undo from c2 -> c1, same round.
    const fwd = advanceTurn(sorted, 1, 1);
    expect(fwd.currentCombatantId).toBe(2);
    const back = retreatTurn(sorted, fwd.currentCombatantId, fwd.round);
    expect(back.currentCombatantId).toBe(1);
    expect(back.round).toBe(1);
  });

  it('unwraps to the last combatant and decrements the round past the top', () => {
    const back = retreatTurn(sorted, 1, 2); // top of round 2 -> last of round 1
    expect(back.currentCombatantId).toBe(3);
    expect(back.round).toBe(1);
  });

  it('never drops the round below 1', () => {
    const back = retreatTurn(sorted, 1, 1);
    expect(back.round).toBe(1);
    expect(back.currentCombatantId).toBe(3);
  });

  it('empty roster clears the pointer', () => {
    expect(retreatTurn([], 1, 3)).toEqual({ turnIndex: 0, round: 3, currentCombatantId: null, skipped: [] });
  });
});

describe('resetTurnStateForStart (issue #413)', () => {
  it('clears action-economy usage + movement but keeps concentration and round-scoped legendary', () => {
    const state: CombatantTurnState = {
      used: { action: 1, bonus: 1, reaction: 1, legendary: 2 },
      movementUsedFt: 30,
      concentration: 'Bless',
      pendingConcentrationChecks: [{ id: 'check-1', damage: 8, dc: 10 }],
      delaying: true,
      readied: 'Attack when they approach',
    };
    const reset = resetTurnStateForStart(state);
    expect(reset.used).toEqual({ legendary: 2 });
    expect(reset.movementUsedFt).toBe(0);
    expect(reset.concentration).toBe('Bless');
    expect(reset.pendingConcentrationChecks).toEqual([{ id: 'check-1', damage: 8, dc: 10 }]);
    expect(reset.delaying).toBe(false);
    expect(reset.readied).toBeNull();
  });
});

describe('tickEffectsAtTurnEnd (issue #413)', () => {
  const eff = (id: string, roundsRemaining: number | null): ActiveEffect => ({
    id,
    name: id,
    kind: 'condition',
    timing: 'none',
    roundsRemaining,
    amount: null,
    saveAbility: null,
    saveDc: null,
    notes: '',
  });

  it('decrements finite durations and expires those reaching 0', () => {
    const { kept, expired } = tickEffectsAtTurnEnd([eff('a', 2), eff('b', 1), eff('c', null)]);
    expect(expired.map((e) => e.id)).toEqual(['b']);
    expect(kept.map((e) => [e.id, e.roundsRemaining])).toEqual([
      ['a', 1],
      ['c', null],
    ]);
  });

  it('leaves indefinite effects untouched', () => {
    const { kept, expired } = tickEffectsAtTurnEnd([eff('x', null)]);
    expect(expired).toHaveLength(0);
    expect(kept[0].roundsRemaining).toBeNull();
  });
});

describe('turn prompts (issue #413)', () => {
  const slots: ActionEconomySlot[] = [...DND5E_ACTION_ECONOMY.slots];

  it('raises a death-save prompt at the start of a dying PC turn', () => {
    const c = combatant(1, 10);
    c.kind = 'character';
    c.deathState = 'dying';
    const prompts = deriveStartTurnPrompts(c);
    expect(prompts.some((p) => p.kind === 'death-save' && p.timing === 'start')).toBe(true);
  });

  it('raises ongoing-damage + repeat-save start prompts from effects', () => {
    const c = combatant(2, 10);
    c.activeEffects = [
      { id: 'fire', name: 'Ongoing Fire', kind: 'ongoing-damage', timing: 'start-of-turn', roundsRemaining: 3, amount: 5, saveAbility: null, saveDc: null, notes: '' },
      { id: 'poison', name: 'Wyvern Poison', kind: 'condition', timing: 'start-of-turn', roundsRemaining: null, amount: null, saveAbility: 'CON', saveDc: 15, notes: '' },
    ];
    const prompts = deriveStartTurnPrompts(c);
    expect(prompts.find((p) => p.kind === 'ongoing-damage')?.message).toContain('5');
    expect(prompts.find((p) => p.kind === 'repeat-save')?.message).toContain('CON');
  });

  it('flags an expiring effect and an unresolved primary action at end of turn', () => {
    const c = combatant(3, 10);
    c.activeEffects = [
      { id: 'haste', name: 'Haste', kind: 'buff', timing: 'none', roundsRemaining: 1, amount: null, saveAbility: null, saveDc: null, notes: '' },
    ];
    // action not used this turn -> unresolved-action prompt for the 'action' slot.
    const prompts = deriveEndTurnPrompts(c, slots);
    expect(prompts.some((p) => p.kind === 'expiring-effect')).toBe(true);
    expect(prompts.some((p) => p.kind === 'unresolved-action')).toBe(true);
  });

  it('does not flag an unresolved action once the action slot is used', () => {
    const c = combatant(4, 10);
    c.turnState.used = { action: 1 };
    const prompts = deriveEndTurnPrompts(c, slots);
    expect(prompts.some((p) => p.kind === 'unresolved-action')).toBe(false);
  });
});

describe('ConditionInstance logic (issue #423)', () => {
  const cond = (id: string, roundsRemaining: number | null, timing: 'start-of-turn' | 'end-of-turn' | 'none' = 'none'): any => ({
    id,
    name: `Condition ${id}`,
    ruleEntryId: null,
    source: 'Spell',
    sourceCombatantId: 10,
    durationRounds: roundsRemaining,
    roundsRemaining,
    timing,
    saveTiming: timing,
    saveDc: 14,
    saveAbility: 'CON',
    isConcentration: false,
    stacks: 1,
    notes: '',
    custom: false,
  });

  it('ticks condition instances down at turn end and expires those reaching 0', () => {
    const { kept, expired } = tickConditionInstancesAtTurnEnd([cond('c1', 2, 'end-of-turn'), cond('c2', 1, 'end-of-turn'), cond('c3', null, 'end-of-turn')]);
    expect(expired.map((c) => c.id)).toEqual(['c2']);
    expect(kept.map((c) => [c.id, c.roundsRemaining])).toEqual([
      ['c1', 1],
      ['c3', null],
    ]);
  });

  it('ticks condition instances down at turn start', () => {
    const { kept, expired } = tickConditionInstancesAtTurnStart([cond('c1', 1, 'start-of-turn'), cond('c2', 2, 'start-of-turn')]);
    expect(expired.map((c) => c.id)).toEqual(['c1']);
    expect(kept.map((c) => [c.id, c.roundsRemaining])).toEqual([['c2', 1]]);
  });

  it('raises start/end repeat-save and expiring condition prompts', () => {
    const c = combatant(5, 10);
    c.conditionInstances = [
      cond('start-save', 2, 'start-of-turn'),
      cond('end-save', 1, 'end-of-turn'),
    ];

    const startPrompts = deriveStartTurnPrompts(c);
    expect(startPrompts.some((p) => p.id === 'repeat-save-cond:start:5:start-save')).toBe(true);

    const endPrompts = deriveEndTurnPrompts(c, [...DND5E_ACTION_ECONOMY.slots]);
    expect(endPrompts.some((p) => p.id === 'expiring-cond:5:end-save')).toBe(true);
    expect(endPrompts.some((p) => p.id === 'repeat-save-cond:end:5:end-save')).toBe(true);
  });

  it('cascades concentration loss across all combatants in encounter', () => {
    const combatants = [
      {
        id: 1,
        conditionInstances: [
          { ...cond('c1', 5), isConcentration: true, sourceCombatantId: 10 },
          { ...cond('c2', 5), isConcentration: false, sourceCombatantId: 10 },
        ],
      },
      {
        id: 2,
        conditionInstances: [
          { ...cond('c3', 5), isConcentration: true, sourceCombatantId: 10 },
        ],
      },
    ];

    const { updatedCombatants, removed } = cascadeConcentrationLoss(combatants, 10);
    expect(removed).toHaveLength(2);
    expect(removed.map((r) => r.condition.id)).toEqual(['c1', 'c3']);
    expect(updatedCombatants.get(1)?.map((c) => c.id)).toEqual(['c2']);
    expect(updatedCombatants.get(2)).toEqual([]);
  });
});
