import type { Combatant } from '@campfire/schema';
import { EMPTY_TURN_STATE, LEGENDARY_ACTION_SLOT } from '@campfire/schema';
import {
  advanceEncounterTurn,
  initialEncounterTurnState,
  lairLeadsRound,
  resetLegendaryUsage,
  resetTurnStateForStart,
  retreatEncounterTurn,
  shouldEnterLairAfterCombatant,
} from '../../src/modules/encounters/encounters.logic';

function combatant(id: number, initiative: number | null): Combatant {
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
    sortOrder: id,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: { ...EMPTY_TURN_STATE, used: { ...EMPTY_TURN_STATE.used } },
    activeEffects: [],
    conditionInstances: [],
    legendaryActions: null,
    statblock: null,
  };
}

describe('boss turn scheduling (issue #618)', () => {
  it('inserts a lair slot after the last combatant with initiative >= 20', () => {
    const sorted = [combatant(1, 25), combatant(2, 20), combatant(3, 12)];
    expect(shouldEnterLairAfterCombatant(sorted[1], sorted)).toBe(true);
    expect(shouldEnterLairAfterCombatant(sorted[0], sorted)).toBe(false);

    const advanced = advanceEncounterTurn(sorted, 2, 1, 'combatant', true, null);
    expect(advanced).toMatchObject({
      phase: 'lair',
      currentCombatantId: null,
      lairResumeCombatantId: 3,
      round: 1,
    });
  });

  it('resumes after lair to the queued combatant', () => {
    const sorted = [combatant(1, 25), combatant(2, 20), combatant(3, 12)];
    const afterLair = advanceEncounterTurn(sorted, null, 1, 'lair', true, 3);
    expect(afterLair).toMatchObject({
      phase: 'combatant',
      currentCombatantId: 3,
      lairResumeCombatantId: null,
    });
  });

  it('starts on the lair slot when nobody rolled 20+', () => {
    const sorted = [combatant(1, 18), combatant(2, 10)];
    expect(lairLeadsRound(sorted)).toBe(true);
    expect(initialEncounterTurnState(sorted, true)).toMatchObject({
      phase: 'lair',
      currentCombatantId: null,
      lairResumeCombatantId: 1,
    });
  });

  it('preserves legendary usage across per-turn resets and clears on round wrap helper', () => {
    const state = {
      ...EMPTY_TURN_STATE,
      used: { action: 1, [LEGENDARY_ACTION_SLOT]: 2 },
    };
    const reset = resetTurnStateForStart(state);
    expect(reset.used).toEqual({ [LEGENDARY_ACTION_SLOT]: 2 });
    expect(resetLegendaryUsage(reset).used).toEqual({});
  });

  it('retreats from lair back to the combatant that triggered it in the same round', () => {
    const sorted = [combatant(1, 25), combatant(2, 20), combatant(3, 12)];
    const retreated = retreatEncounterTurn(sorted, null, 1, 'lair', true, 3);
    expect(retreated).toMatchObject({
      phase: 'combatant',
      currentCombatantId: 2,
      round: 1,
      lairResumeCombatantId: null,
    });
  });

  it('retreats from a round-starting lair slot to the previous round last combatant', () => {
    const sorted = [combatant(1, 18), combatant(2, 10)];
    const retreated = retreatEncounterTurn(sorted, null, 2, 'lair', true, 1);
    expect(retreated).toMatchObject({
      phase: 'combatant',
      currentCombatantId: 2,
      round: 1,
      roundWrapped: true,
    });
  });
});
