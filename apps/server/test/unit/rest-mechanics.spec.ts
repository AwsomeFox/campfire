import {
  Dnd5eAdapter,
  HIT_DICE_RESOURCE_KEY,
  restConditionOutcome,
  NEUTRAL_REST_MODEL,
  planCharacterRest,
  planPartyRest,
  planPartyCustomRecovery,
  RECHARGE_RECOVERED_BY_REST,
  resetSpellSlotsForRest,
  restModelForAdapter,
  ruleSystemAdapter,
  UNTAGGED_RESOURCE_CADENCE,
  RestAdapter,
  RestCharacterState,
  RestConditionState,
  RestKind,
  RestRechargeCadence,
} from '@campfire/schema';

/**
 * #1041 — short rest / long rest, pure recovery math.
 *
 * The properties worth pinning are the ones a "just set HP to max and zero everything" version
 * would get wrong: which cadences each rest actually refills, that unknown conditions SURVIVE a
 * rest rather than being silently deleted, that a party plan fails as a unit, and that a system
 * which declares no rest rules recovers nothing it did not declare.
 */

/** A d20-style deterministic roller: always the maximum face, so healing is exact. */
const maxRoll = (sides: number) => sides;
/** Always 1, for asserting the low end. */
const minRoll = () => 1;

/** A condition at a given stack count (default 1 — a plain, non-leveled condition). */
const cond = (name: string, stacks = 1): RestConditionState => ({ name, stacks });

function character(over: Partial<RestCharacterState> = {}): RestCharacterState {
  return {
    id: 1,
    name: 'Vesh',
    level: 5,
    hpCurrent: 12,
    hpMax: 40,
    hpTemp: 0,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    stats: { CON: 14 },
    spellSlots: {},
    resources: {},
    ...over,
  };
}

const fiveE = ruleSystemAdapter('dnd5e') as unknown as RestAdapter;

/** An adapter that declares nothing — the six ship-in-repo systems with no rest vocabulary. */
const bareAdapter: RestAdapter = {
  id: 'bare',
  abilityModifier: (score) => Math.floor((score - 10) / 2),
};

function planOf(
  adapter: RestAdapter,
  state: RestCharacterState,
  kind: RestKind,
  options = {},
  roll = maxRoll,
) {
  const result = planCharacterRest(adapter, state, kind, options, roll);
  if ('failure' in result) throw new Error(`expected a plan, got failure: ${result.failure.detail}`);
  return result.plan;
}

describe('recharge cadence → rest mapping (#1041)', () => {
  it('answers every cadence for every rest kind', () => {
    // `Record<RestKind, Record<RestRechargeCadence, boolean>>` makes a missing cadence a
    // compile error; restating the keys here makes the intent legible to a reader.
    const cadences: RestRechargeCadence[] = ['short-rest', 'long-rest', 'refocus', 'dawn', 'turn-start', 'special'];
    for (const kind of ['short', 'long'] as RestKind[]) {
      expect(Object.keys(RECHARGE_RECOVERED_BY_REST[kind]).sort()).toEqual([...cadences].sort());
    }
  });

  it('a long rest subsumes a short rest, but never the reverse', () => {
    for (const cadence of Object.keys(RECHARGE_RECOVERED_BY_REST.short) as RestRechargeCadence[]) {
      if (RECHARGE_RECOVERED_BY_REST.short[cadence]) {
        expect(RECHARGE_RECOVERED_BY_REST.long[cadence]).toBe(true);
      }
    }
    expect(RECHARGE_RECOVERED_BY_REST.short['long-rest']).toBe(false);
  });

  it('a short rest does NOT grant a refocus', () => {
    // The dead `restCharacter` recharged `refocus` on a short rest. A PF2e Refocus is a
    // deliberate 10-minute activity, not something a short rest hands you.
    expect(RECHARGE_RECOVERED_BY_REST.short.refocus).toBe(false);
    expect(RECHARGE_RECOVERED_BY_REST.long.refocus).toBe(true);
  });

  it('never touches per-turn or special recharges', () => {
    // `turn-start` is encounter-scoped and owned by the turn tracker; `special` means "the
    // system did not model this", and a rest must not guess.
    for (const kind of ['short', 'long'] as RestKind[]) {
      expect(RECHARGE_RECOVERED_BY_REST[kind]['turn-start']).toBe(false);
      expect(RECHARGE_RECOVERED_BY_REST[kind].special).toBe(false);
    }
  });

  it('treats an untagged resource as long-rest, matching resourceVocabularyForAdapter', () => {
    expect(UNTAGGED_RESOURCE_CADENCE).toBe('long-rest');
    const state = character({ resources: { homebrew: { max: 3, used: 3 } } });
    expect(planOf(fiveE, state, 'short').resourcesAfter.homebrew.used).toBe(3);
    expect(planOf(fiveE, state, 'long').resourcesAfter.homebrew.used).toBe(0);
  });

  it('refills resources by their declared cadence, not by name', () => {
    const state = character({
      resources: {
        actionSurge: { max: 1, used: 1, recharge: 'short-rest' },
        rage: { max: 3, used: 2, recharge: 'long-rest' },
        recharge: { max: 1, used: 1, recharge: 'turn-start' },
      },
    });
    const short = planOf(fiveE, state, 'short');
    expect(short.resourcesAfter.actionSurge.used).toBe(0);
    expect(short.resourcesAfter.rage.used).toBe(2);
    expect(short.resourcesAfter.recharge.used).toBe(1);

    const long = planOf(fiveE, state, 'long');
    expect(long.resourcesAfter.actionSurge.used).toBe(0);
    expect(long.resourcesAfter.rage.used).toBe(0);
    expect(long.resourcesAfter.recharge.used).toBe(1);
  });
});

describe('conditions: an allowlist that fails CLOSED (#1041 × #1047)', () => {
  it('clears only what the adapter says a rest clears', () => {
    // Exhaustion at 1 stack decrements to 0 — which IS a full clear (issue #1641): there is no
    // "exhaustion 0" state for a leveled condition to sit at. See the dedicated decrement tests
    // below for the level 5 → 4 case this issue actually exists to fix.
    const state = character({ conditions: [cond('Exhaustion'), cond('Petrified')] });
    const plan = planOf(fiveE, state, 'long');
    expect(plan.conditionsCleared).toEqual(['Exhaustion']);
    expect(plan.conditionsKept).toEqual(['Petrified']);
    expect(plan.conditionsAfter).toEqual([cond('Petrified')]);
  });

  it('LEAVES an unrecognised condition in place rather than deleting it', () => {
    // This is the whole reason the list is an allowlist. Conditions are bare strings with a
    // user-extensible vocabulary; a denylist of "permanent" conditions would silently delete
    // a homebrew curse on a night's sleep and nobody could tell from the result.
    const state = character({ conditions: [cond('lycanthropy'), cond('Level Drain'), cond('DM: cursed by the idol')] });
    const plan = planOf(fiveE, state, 'long');
    expect(plan.conditionsCleared).toEqual([]);
    expect(plan.conditionsAfter).toEqual([cond('lycanthropy'), cond('Level Drain'), cond('DM: cursed by the idol')]);
  });

  it('matches case-insensitively and preserves the stored casing', () => {
    const state = character({ conditions: [cond('EXHAUSTION'), cond('unconscious')] });
    const plan = planOf(fiveE, state, 'long');
    expect(plan.conditionsCleared).toEqual(['EXHAUSTION', 'unconscious']);
  });

  it('a short rest clears nothing under 5e', () => {
    const state = character({ conditions: [cond('Exhaustion')] });
    expect(planOf(fiveE, state, 'short').conditionsCleared).toEqual([]);
  });

  it('an adapter with no rest model clears nothing at all', () => {
    // A 13th Age or Ironsworn table must not inherit 5e's condition list just because 5e is the
    // fallback adapter — nor does an unrecognised adapter id inherit 5e's leveled-condition track.
    const state = character({ conditions: [cond('Exhaustion'), cond('Prone')] });
    expect(planOf(bareAdapter, state, 'long').conditionsCleared).toEqual([]);
    expect(restModelForAdapter(bareAdapter)).toEqual(NEUTRAL_REST_MODEL);
  });

  it('never treats an empty or whitespace condition as clearable', () => {
    expect(restConditionOutcome('', 'long', restModelForAdapter(fiveE), fiveE.id)).toBe('keep');
    expect(restConditionOutcome('   ', 'long', restModelForAdapter(fiveE), fiveE.id)).toBe('keep');
  });

  it('5e does not end conditions that need a cure', () => {
    const model = restModelForAdapter(fiveE);
    for (const needsCure of ['Petrified', 'Paralyzed', 'Charmed', 'Poisoned', 'Restrained', 'Blinded']) {
      expect(restConditionOutcome(needsCure, 'long', model, fiveE.id)).toBe('keep');
    }
  });
});

describe('5e exhaustion is a LEVEL a long rest drops by one, not a switch it clears (#1641)', () => {
  it('exhaustion 5 -> long rest -> 4, not 0', () => {
    const state = character({ conditions: [cond('Exhaustion', 5)] });
    const plan = planOf(fiveE, state, 'long');
    expect(plan.conditionsCleared).toEqual([]);
    expect(plan.conditionsKept).toEqual(['Exhaustion']);
    expect(plan.conditionsDecremented).toEqual([{ name: 'Exhaustion', stacksBefore: 5, stacksAfter: 4 }]);
    expect(plan.conditionsAfter).toEqual([cond('Exhaustion', 4)]);
  });

  it('exhaustion 1 -> long rest -> condition gone entirely', () => {
    const state = character({ conditions: [cond('Exhaustion', 1)] });
    const plan = planOf(fiveE, state, 'long');
    expect(plan.conditionsCleared).toEqual(['Exhaustion']);
    expect(plan.conditionsKept).toEqual([]);
    expect(plan.conditionsDecremented).toEqual([]);
    expect(plan.conditionsAfter).toEqual([]);
  });

  it('a SHORT rest does not touch exhaustion at all', () => {
    const state = character({ conditions: [cond('Exhaustion', 3)] });
    const plan = planOf(fiveE, state, 'short');
    expect(plan.conditionsCleared).toEqual([]);
    expect(plan.conditionsDecremented).toEqual([]);
    expect(plan.conditionsAfter).toEqual([cond('Exhaustion', 3)]);
  });

  it('a non-stacked long-rest-cleared condition still clears entirely, regardless of its stacks', () => {
    // The regression guard: Prone/Frightened/Unconscious are in `clearedByLongRest`, not the
    // leveled-condition track, so they must be removed OUTRIGHT — never decremented — no matter
    // what `stacks` happens to hold. Get this backwards and every 5e rest breaks.
    const state = character({ conditions: [cond('Prone'), cond('Frightened'), cond('Unconscious')] });
    const plan = planOf(fiveE, state, 'long');
    expect(plan.conditionsCleared.sort()).toEqual(['Frightened', 'Prone', 'Unconscious']);
    expect(plan.conditionsDecremented).toEqual([]);
    expect(plan.conditionsAfter).toEqual([]);
  });

  it('PF2e has no exhaustion track: a same-named condition just survives (allowlist fails closed)', () => {
    const pf2e = ruleSystemAdapter('pf2e') as unknown as RestAdapter;
    const state = character({ conditions: [cond('Exhaustion', 5)] });
    const plan = planOf(pf2e, state, 'long');
    expect(plan.conditionsCleared).toEqual([]);
    expect(plan.conditionsDecremented).toEqual([]);
    expect(plan.conditionsKept).toEqual(['Exhaustion']);
  });
});

describe('hit points, temp HP, death saves (#1041)', () => {
  it('a long rest restores HP to full and drops temp HP', () => {
    const plan = planOf(fiveE, character({ hpCurrent: 3, hpTemp: 7 }), 'long');
    expect(plan.hpAfter).toBe(40);
    // Temp HP is a granted buffer, not stored health — it does not survive the night.
    expect(plan.hpTempAfter).toBe(0);
  });

  it('a short rest heals ONLY what hit dice roll, and leaves temp HP alone', () => {
    const state = character({
      hpCurrent: 10,
      hpTemp: 5,
      resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0, recharge: 'long-rest' } },
    });
    // 2 × max(d8) + CON(+2) each = 2 × 10 = 20.
    const plan = planOf(fiveE, state, 'short', { spendHitDice: 2, hitDie: 8 }, maxRoll);
    expect(plan.hitDiceRolls).toEqual([8, 8]);
    expect(plan.hpAfter).toBe(30);
    expect(plan.hpTempAfter).toBe(5);
    expect(plan.resourcesAfter[HIT_DICE_RESOURCE_KEY].used).toBe(2);
  });

  it('never heals past hpMax', () => {
    const state = character({
      hpCurrent: 38,
      resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } },
    });
    expect(planOf(fiveE, state, 'short', { spendHitDice: 3, hitDie: 12 }, maxRoll).hpAfter).toBe(40);
  });

  it('a hit die never heals a negative amount even with a CON penalty', () => {
    const state = character({
      hpCurrent: 10,
      stats: { CON: 4 }, // -3
      resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } },
    });
    const plan = planOf(fiveE, state, 'short', { spendHitDice: 2, hitDie: 6 }, minRoll);
    // 1 + (-3) would be -2 per die; clamped to 0, so no healing and certainly no damage.
    expect(plan.hpAfter).toBe(10);
  });

  it('a long rest resets death saves and stands a dying character up', () => {
    const plan = planOf(
      fiveE,
      character({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 1, deathSaveFailures: 2 }),
      'long',
    );
    expect(plan.deathStateAfter).toBe('none');
    expect(plan.deathSaveSuccessesAfter).toBe(0);
    expect(plan.deathSaveFailuresAfter).toBe(0);
  });

  it('a short rest that heals a dying character above 0 stabilises them', () => {
    const state = character({
      hpCurrent: 0,
      deathState: 'dying',
      deathSaveFailures: 2,
      resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } },
    });
    const plan = planOf(fiveE, state, 'short', { spendHitDice: 1, hitDie: 8 }, maxRoll);
    expect(plan.hpAfter).toBeGreaterThan(0);
    expect(plan.deathStateAfter).toBe('none');
  });

  it('refuses to rest a DEAD character', () => {
    const result = planCharacterRest(fiveE, character({ deathState: 'dead' }), 'long', {}, maxRoll);
    expect('failure' in result && result.failure.error).toBe('character_dead');
  });
});

describe('hit dice: refuse rather than guess (#1041)', () => {
  it('rejects a short rest that spends hit dice with no known die size', () => {
    // 5e hit dice are per-class and the class die is not stored on the sheet anywhere in this
    // repo. Inventing a d8 for a barbarian silently under-heals them, and the result gives no
    // hint that it happened.
    const state = character({ resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } } });
    const result = planCharacterRest(fiveE, state, 'short', { spendHitDice: 1 }, maxRoll);
    expect('failure' in result && result.failure.error).toBe('hit_die_unknown');
    expect('failure' in result && result.failure.detail).toMatch(/hitDie/);
  });

  it('rejects spending more hit dice than are available', () => {
    const state = character({ resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 4 } } });
    const result = planCharacterRest(fiveE, state, 'short', { spendHitDice: 2, hitDie: 8 }, maxRoll);
    expect('failure' in result && result.failure.error).toBe('insufficient_hit_dice');
  });

  it('rejects spending hit dice on a LONG rest', () => {
    const state = character({ resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } } });
    const result = planCharacterRest(fiveE, state, 'long', { spendHitDice: 1, hitDie: 8 }, maxRoll);
    expect('failure' in result && result.failure.error).toBe('hit_dice_unsupported');
  });

  it('a long rest returns HALF the hit dice under 5e, minimum one', () => {
    const spent = character({ resources: { [HIT_DICE_RESOURCE_KEY]: { max: 6, used: 6, recharge: 'long-rest' } } });
    expect(planOf(fiveE, spent, 'long').hitDiceRecovered).toBe(3);
    expect(planOf(fiveE, spent, 'long').resourcesAfter[HIT_DICE_RESOURCE_KEY].used).toBe(3);

    // A level-1 character has one hit die; half of one floors to zero, and never getting it
    // back would strand them permanently.
    const level1 = character({ resources: { [HIT_DICE_RESOURCE_KEY]: { max: 1, used: 1, recharge: 'long-rest' } } });
    expect(planOf(fiveE, level1, 'long').hitDiceRecovered).toBe(1);
  });

  it('returns nothing when none were spent', () => {
    const rested = character({ resources: { [HIT_DICE_RESOURCE_KEY]: { max: 6, used: 0, recharge: 'long-rest' } } });
    expect(planOf(fiveE, rested, 'long').hitDiceRecovered).toBe(0);
  });
});

describe('spell slots (#1041, seam for #1039)', () => {
  it('a long rest zeroes used slots at every level and keeps maxima', () => {
    const { slots, levelsRecovered } = resetSpellSlotsForRest(
      { '1': { max: 4, used: 4 }, '3': { max: 2, used: 1 }, '5': { max: 1, used: 0 } },
      'long',
    );
    expect(slots).toEqual({ '1': { max: 4, used: 0 }, '3': { max: 2, used: 0 }, '5': { max: 1, used: 0 } });
    expect(levelsRecovered.sort()).toEqual(['1', '3']);
  });

  it('a short rest recovers no ordinary spell slots', () => {
    // Pact magic recovering on a short rest is #1039's problem; inventing it here would hand
    // every 5e caster free slots.
    const { slots, levelsRecovered } = resetSpellSlotsForRest({ '1': { max: 4, used: 4 } }, 'short');
    expect(slots['1'].used).toBe(4);
    expect(levelsRecovered).toEqual([]);
  });
});

describe('party planning is all-or-nothing (#1041)', () => {
  const party = [
    character({ id: 1, name: 'Vesh', hpCurrent: 5 }),
    character({ id: 2, name: 'Bram', hpCurrent: 1 }),
    character({ id: 3, name: 'Sil', hpCurrent: 40 }),
  ];

  it('plans every character when all are valid', () => {
    const plan = planPartyRest(fiveE, party, 'long', {}, maxRoll);
    expect(plan.failures).toEqual([]);
    expect(plan.plans.map((p) => p.characterId)).toEqual([1, 2, 3]);
    expect(plan.plans.every((p) => p.hpAfter === 40)).toBe(true);
    expect(plan.ruleSystem).toBe(Dnd5eAdapter.id);
  });

  it('surfaces EVERY failure rather than stopping at the first', () => {
    // The caller applies nothing when `failures` is non-empty, so a DM should be told about all
    // the problems at once instead of fixing them one rejected call at a time.
    const withProblems = [
      character({ id: 1, name: 'Vesh', resources: { [HIT_DICE_RESOURCE_KEY]: { max: 1, used: 1 } } }),
      character({ id: 2, name: 'Bram', deathState: 'dead' }),
      character({ id: 3, name: 'Sil' }),
    ];
    const plan = planPartyRest(fiveE, withProblems, 'short', { 1: { spendHitDice: 1, hitDie: 8 } }, maxRoll);
    expect(plan.failures.map((f) => f.error).sort()).toEqual(['character_dead', 'insufficient_hit_dice']);
    // The one valid character still has a plan — but the CALLER is contractually required not
    // to apply it while any failure exists.
    expect(plan.plans.map((p) => p.characterId)).toEqual([3]);
  });

  it('applies per-character options only to the character they name', () => {
    const withDice = [
      character({ id: 1, name: 'Vesh', hpCurrent: 10, resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } } }),
      character({ id: 2, name: 'Bram', hpCurrent: 10, resources: { [HIT_DICE_RESOURCE_KEY]: { max: 5, used: 0 } } }),
    ];
    const plan = planPartyRest(fiveE, withDice, 'short', { 1: { spendHitDice: 2, hitDie: 8 } }, maxRoll);
    expect(plan.plans[0].hitDiceSpent).toBe(2);
    expect(plan.plans[1].hitDiceSpent).toBe(0);
    expect(plan.plans[1].hpAfter).toBe(10);
  });

  it('custom recovery restores only explicitly selected pools and keeps every other sheet field', () => {
    const plan = planPartyCustomRecovery(fiveE, [character({ resources: { rage: { max: 3, used: 2 }, actionSurge: { max: 1, used: 1 } }, hpCurrent: 9, conditions: [{ name: 'poisoned', stacks: 1 }] })], ['rage']);
    expect(plan.kind).toBe('custom');
    expect(plan.failures).toEqual([]);
    expect(plan.plans[0].resourcesAfter.rage.used).toBe(0);
    expect(plan.plans[0].resourcesAfter.actionSurge.used).toBe(1);
    expect(plan.plans[0].hpAfter).toBe(9);
    expect(plan.plans[0].conditionsAfter).toEqual([{ name: 'poisoned', stacks: 1 }]);
  });
});
