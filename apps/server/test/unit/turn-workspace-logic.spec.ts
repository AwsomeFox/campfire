import type { ActionEconomySlot, ActiveEffect, Combatant, CombatantTurnState } from '@campfire/schema';
import { DND5E_ACTION_ECONOMY, EMPTY_TURN_STATE, actionEconomyForAdapter, Dnd5eAdapter, OpenLegendAdapter } from '@campfire/schema';
import {
  advanceTurn,
  deriveEndTurnPrompts,
  deriveStartTurnPrompts,
  resetTurnStateForStart,
  retreatTurn,
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
    initiativeGroup: null,
    hpCurrent: 10,
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
    sortOrder,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: { ...EMPTY_TURN_STATE },
    activeEffects: [],
    legendaryActions: null,
  };
}

describe('adapter action economy (issue #413)', () => {
  it('5e defines action / bonus / reaction / movement', () => {
    const model = actionEconomyForAdapter(Dnd5eAdapter);
    expect(model.slots.map((s) => s.key)).toEqual(['action', 'bonus', 'reaction', 'movement']);
    expect(model).toBe(DND5E_ACTION_ECONOMY);
  });

  it('an adapter without action economy falls back to the neutral single Action, not 5e', () => {
    // OpenLegend does not define one — it must NOT inherit 5e bonus/reaction slots.
    const model = actionEconomyForAdapter(OpenLegendAdapter);
    expect(model.slots).toHaveLength(1);
    expect(model.slots[0].key).toBe('action');
  });
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
    expect(retreatTurn([], 1, 3)).toEqual({ turnIndex: 0, round: 3, currentCombatantId: null });
  });
});

describe('resetTurnStateForStart (issue #413)', () => {
  it('clears action-economy usage + movement but keeps concentration and round-scoped legendary', () => {
    const state: CombatantTurnState = {
      used: { action: 1, bonus: 1, reaction: 1, legendary: 2 },
      movementUsedFt: 30,
      concentration: 'Bless',
      delaying: true,
      readied: 'Attack when they approach',
    };
    const reset = resetTurnStateForStart(state);
    expect(reset.used).toEqual({ legendary: 2 });
    expect(reset.movementUsedFt).toBe(0);
    expect(reset.concentration).toBe('Bless');
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
    c.turnState = { ...EMPTY_TURN_STATE, used: { action: 1 } };
    const prompts = deriveEndTurnPrompts(c, slots);
    expect(prompts.some((p) => p.kind === 'unresolved-action')).toBe(false);
  });
});
