import {
  OsrAdapter,
  OSR_ADAPTER_ID,
  OSR_RULE_SYSTEM_SLUGS,
  OSR_CONDITIONS,
  OSR_SAVES,
  ruleSystemAdapter,
  Dnd5eAdapter,
  osrAbilityModifier,
  savingThrowSucceeds,
  descendingToAscendingAc,
  ascendingToDescendingAc,
  thac0ToAttackBonus,
  attackBonusToThac0,
  osrAttackHits,
} from '@campfire/schema';

/**
 * Unit tests for the shared OSR RuleSystemAdapter (issue #300). Focus areas called out in
 * the issue: the B/X ability-modifier table, the descending-vs-ascending AC handling (they
 * MUST agree), simple saving throws, the condition vocabulary, and statblock mapping.
 */
describe('OsrAdapter — B/X ability modifier', () => {
  it.each([
    [3, -3],
    [4, -2],
    [5, -2],
    [6, -1],
    [8, -1],
    [9, 0],
    [12, 0],
    [13, 1],
    [15, 1],
    [16, 2],
    [17, 2],
    [18, 3],
  ])('score %i -> modifier %i (banded B/X table)', (score, mod) => {
    expect(osrAbilityModifier(score)).toBe(mod);
    expect(OsrAdapter.abilityModifier(score)).toBe(mod);
  });

  it('clamps out-of-band scores to ±3 and returns 0 for non-finite', () => {
    expect(osrAbilityModifier(0)).toBe(-3);
    expect(osrAbilityModifier(2)).toBe(-3);
    expect(osrAbilityModifier(19)).toBe(3);
    expect(osrAbilityModifier(25)).toBe(3);
    expect(osrAbilityModifier(NaN)).toBe(0);
  });

  it('differs from 5e at the extremes (proves it is NOT the 5e formula)', () => {
    expect(OsrAdapter.abilityModifier(18)).toBe(3); // 5e would be +4
    expect(Dnd5eAdapter.abilityModifier(18)).toBe(4);
  });
});

describe('OsrAdapter — initiative (individual d6 + DEX mod)', () => {
  it('uses a d6 initiative die', () => {
    expect(OsrAdapter.initiativeDie).toBe(6);
  });
  it('derives the init modifier from DEX using the B/X table (canonical or raw keys)', () => {
    expect(OsrAdapter.initiativeModifier({ DEX: 16 })).toBe(2);
    expect(OsrAdapter.initiativeModifier({ dexterity: 18 })).toBe(3);
    expect(OsrAdapter.initiativeModifier({ DEX: 9 })).toBe(0);
  });
  it('returns 0 when DEX is absent or non-numeric', () => {
    expect(OsrAdapter.initiativeModifier({ STR: 16 })).toBe(0);
    expect(OsrAdapter.initiativeModifier({})).toBe(0);
    expect(OsrAdapter.initiativeModifier(null)).toBe(0);
    expect(OsrAdapter.initiativeModifier(undefined)).toBe(0);
  });
});

describe('OsrAdapter — saving throws (five B/X categories)', () => {
  it('exposes the five OSR save categories', () => {
    expect(OSR_SAVES).toEqual(['Death Ray or Poison', 'Magic Wands', 'Paralysis or Petrify', 'Dragon Breath', 'Spells']);
  });
  it('succeeds on meet-or-beat of the (lower-is-better) target, with modifiers', () => {
    expect(savingThrowSucceeds(12, 12)).toBe(true); // exact = success
    expect(savingThrowSucceeds(11, 12)).toBe(false);
    expect(savingThrowSucceeds(10, 12, 2)).toBe(true); // +2 bonus reaches 12
  });
  it('natural 20 always succeeds, natural 1 always fails, regardless of target', () => {
    expect(savingThrowSucceeds(20, 99)).toBe(true);
    expect(savingThrowSucceeds(1, 2)).toBe(false);
  });
});

describe('OsrAdapter — AC conversion (descending <-> ascending)', () => {
  it.each([
    [9, 10], // unarmored
    [7, 12],
    [2, 17], // plate
    [0, 19], // THAC0 reference point
  ])('descending %i <-> ascending %i (19 - x, self-inverse)', (dac, aac) => {
    expect(descendingToAscendingAc(dac)).toBe(aac);
    expect(ascendingToDescendingAc(aac)).toBe(dac);
  });

  it('THAC0 <-> ascending attack bonus is 19 - x and self-inverse', () => {
    expect(thac0ToAttackBonus(19)).toBe(0);
    expect(thac0ToAttackBonus(15)).toBe(4);
    expect(attackBonusToThac0(0)).toBe(19);
    expect(attackBonusToThac0(4)).toBe(15);
  });
});

describe('OsrAdapter — to-hit resolves IDENTICALLY in both AC conventions', () => {
  // For every combination of roll / THAC0 / descending AC, the descending check and the
  // ascending check (using the converted AC + attack bonus) must agree — this is the whole
  // point of a single shared OSR adapter supporting both clone styles.
  const rolls = [2, 5, 10, 14, 19];
  const thac0s = [19, 17, 15];
  const descendingAcs = [9, 7, 5, 2, 0];

  it('agrees across the full grid', () => {
    for (const roll of rolls) {
      for (const thac0 of thac0s) {
        for (const dac of descendingAcs) {
          const descHit = osrAttackHits({ roll, thac0, targetAc: dac, mode: 'descending' });
          const ascHit = osrAttackHits({ roll, thac0, targetAc: descendingToAscendingAc(dac), mode: 'ascending' });
          expect(ascHit).toBe(descHit);
        }
      }
    }
  });

  it('matches the classic rule: hit iff roll >= THAC0 - AC (descending)', () => {
    // THAC0 15 vs descending AC 5 needs a 10.
    expect(osrAttackHits({ roll: 10, thac0: 15, targetAc: 5, mode: 'descending' })).toBe(true);
    expect(osrAttackHits({ roll: 9, thac0: 15, targetAc: 5, mode: 'descending' })).toBe(false);
    // Same fight in ascending terms: AC 14, attack bonus +4, need total >= 14 -> roll 10.
    expect(osrAttackHits({ roll: 10, thac0: 15, targetAc: descendingToAscendingAc(5), mode: 'ascending' })).toBe(true);
    expect(osrAttackHits({ roll: 9, thac0: 15, targetAc: descendingToAscendingAc(5), mode: 'ascending' })).toBe(false);
  });

  it('natural 1 always misses and natural 20 always hits in either mode', () => {
    expect(osrAttackHits({ roll: 1, thac0: 15, targetAc: 9, mode: 'descending' })).toBe(false);
    expect(osrAttackHits({ roll: 1, thac0: 15, targetAc: 10, mode: 'ascending' })).toBe(false);
    expect(osrAttackHits({ roll: 20, thac0: 20, targetAc: -5, mode: 'descending' })).toBe(true);
    expect(osrAttackHits({ roll: 20, thac0: 20, targetAc: 24, mode: 'ascending' })).toBe(true);
  });
});

describe('OsrAdapter — condition vocabulary', () => {
  it('is the leaner OSR list (has Sleeping/Held, lacks 5e-only Exhaustion/Restrained)', () => {
    expect(OsrAdapter.conditions).toBe(OSR_CONDITIONS);
    expect(OsrAdapter.conditions).toContain('Sleeping');
    expect(OsrAdapter.conditions).toContain('Held');
    expect(OsrAdapter.conditions).not.toContain('Exhaustion');
    expect(OsrAdapter.conditions).not.toContain('Restrained');
  });
});

describe('OsrAdapter — statblock mapping', () => {
  it('maps HD to the CR slot and normalizes AC to ascending', () => {
    const mapped = OsrAdapter.mapStatblock({
      type: 'Undead',
      hitDice: '2',
      armorClass: 13, // descending -> ascending 6
      hitPoints: 9,
      movement: '20’',
      attacks: [{ name: 'Claw' }],
    });
    expect(mapped.creatureType).toBe('Undead');
    expect(mapped.challengeRating).toBe('2');
    expect(mapped.armorClass).toBe(descendingToAscendingAc(13)); // 6
    expect(mapped.hitPoints).toBe(9);
    expect(mapped.speed).toBe('20’');
    expect(mapped.actions).toEqual([{ name: 'Claw' }]);
    expect(mapped.abilityScores).toBeUndefined(); // OSR monsters have no ability scores
  });

  it('prefers an explicit ascending AC when the source provides one', () => {
    const mapped = OsrAdapter.mapStatblock({ armorClass: 13, armorClassAscending: 7 });
    expect(mapped.armorClass).toBe(7);
  });

  it('resolves a monster max HP (rounded), or null when unavailable', () => {
    expect(OsrAdapter.monsterHitPoints({ hitPoints: 7 })).toBe(7);
    expect(OsrAdapter.monsterHitPoints({ hp: 3.4 })).toBe(3);
    expect(OsrAdapter.monsterHitPoints({ hitPoints: 0 })).toBeNull();
    expect(OsrAdapter.monsterHitPoints({})).toBeNull();
  });
});

describe('OsrAdapter — registry resolution', () => {
  it('resolves the shared OSR adapter for every clone slug', () => {
    for (const slug of OSR_RULE_SYSTEM_SLUGS) {
      expect(ruleSystemAdapter(slug)).toBe(OsrAdapter);
    }
  });
  it('has the stable OSR family id', () => {
    expect(OsrAdapter.id).toBe(OSR_ADAPTER_ID);
    expect(OSR_ADAPTER_ID).toBe('osr');
  });
  it('does NOT hijack 5e / unknown slugs (they still fall back to 5e)', () => {
    expect(ruleSystemAdapter('open5e-srd')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('pathfinder-2e')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('')).toBe(Dnd5eAdapter);
  });
});
