import {
  Pf2eAdapter,
  PF2E_ADAPTER_ID,
  PF2E_PACK_SLUG,
  PF2E_CONDITIONS,
  PF2E_DAMAGE_TYPES,
  PF2E_DAMAGE_TYPE_CATEGORIES,
  DND5E_DAMAGE_TYPES,
  Sf2eAdapter,
  SF2E_ADAPTER_ID,
  SF2E_PACK_SLUG,
  ruleSystemAdapter,
  resolveAbilityModifier,
  pf2eProficiencyBonus,
  pf2eLevelBasedDC,
  pf2eSimpleDC,
  pf2eDegreeOfSuccess,
  damageDefensesFromStatblock,
} from '@campfire/schema';

/**
 * Unit tests for the Pathfinder 2e RuleSystemAdapter (issue #295). PF2e math is the
 * adapter's durable, data-independent core, so it is tested thoroughly here: ability
 * modifier, proficiency = level + rank, the level-based DC table, degrees of success
 * (crit at ±10, natural 20/1 shift), the condition vocabulary, PF2e-specific initiative
 * (Perception, not DEX), statblock mapping, and registry resolution by pack slug.
 */
describe('Pf2eAdapter — identity + registry resolution', () => {
  it('has the PF2e family id and label', () => {
    expect(Pf2eAdapter.id).toBe('pf2e');
    expect(PF2E_ADAPTER_ID).toBe('pf2e');
    expect(Pf2eAdapter.label).toBe('Pathfinder 2e');
  });

  it('resolves from the PF2e pack slug a campaign stores in ruleSystem', () => {
    expect(ruleSystemAdapter(PF2E_PACK_SLUG)).toBe(Pf2eAdapter);
    expect(ruleSystemAdapter('pf2e-srd')).toBe(Pf2eAdapter);
  });

  it('resolves from the PF2e family id', () => {
    expect(ruleSystemAdapter('pf2e')).toBe(Pf2eAdapter);
  });
});

describe('Sf2eAdapter — identity + registry resolution', () => {
  it('has the SF2e family id and label', () => {
    expect(Sf2eAdapter.id).toBe('sf2e');
    expect(SF2E_ADAPTER_ID).toBe('sf2e');
    expect(Sf2eAdapter.label).toBe('Starfinder 2e');
  });

  it('resolves from the SF2e pack slug a campaign stores in ruleSystem', () => {
    expect(ruleSystemAdapter(SF2E_PACK_SLUG)).toBe(Sf2eAdapter);
    expect(ruleSystemAdapter('sf2e-srd')).toBe(Sf2eAdapter);
  });

  it('resolves from the SF2e family id', () => {
    expect(ruleSystemAdapter('sf2e')).toBe(Sf2eAdapter);
  });
});

describe('Pf2eAdapter — ability modifier', () => {
  it.each([
    [1, -5],
    [8, -1],
    [10, 0],
    [12, 1],
    [18, 4],
    [20, 5],
  ])('character score %i -> modifier %i (score conversion stays on characters)', (score, mod) => {
    expect(Pf2eAdapter.abilityModifier(score)).toBe(mod);
    expect(resolveAbilityModifier(Pf2eAdapter, score, 'score')).toBe(mod);
  });

  it.each([
    [0, 0],
    [-1, -1],
    [3, 3],
    [9, 9],
    [12, 12],
  ])('creature modifier %i is consumed as-is (no second conversion)', (mod, expected) => {
    expect(resolveAbilityModifier(Pf2eAdapter, mod, 'modifier')).toBe(expected);
  });

  it('does not re-apply the score formula to a typical creature DEX mod (the #767 bug)', () => {
    // DEX +3 stored as 3 must stay +3; floor((3-10)/2) = -4 was the broken rendering.
    expect(resolveAbilityModifier(Pf2eAdapter, 3, 'modifier')).toBe(3);
    expect(Pf2eAdapter.abilityModifier(3)).toBe(-4);
  });
});

describe('Pf2eAdapter — proficiency = level + rank bonus', () => {
  it('untrained is a flat +0 (level not added)', () => {
    expect(pf2eProficiencyBonus(5, 'untrained')).toBe(0);
    expect(pf2eProficiencyBonus(20, 'untrained')).toBe(0);
  });

  it.each([
    [1, 'trained', 3],
    [1, 'expert', 5],
    [5, 'trained', 7],
    [5, 'expert', 9],
    [5, 'master', 11],
    [10, 'legendary', 18],
    [20, 'legendary', 28],
  ] as const)('level %i %s -> +%i', (level, rank, expected) => {
    expect(pf2eProficiencyBonus(level, rank)).toBe(expected);
  });

  it('is exposed on the adapter object', () => {
    expect(Pf2eAdapter.proficiencyBonus(5, 'expert')).toBe(9);
  });
});

describe('Pf2eAdapter — level-based DC table (GM Core)', () => {
  it.each([
    [0, 14],
    [1, 15],
    [2, 16],
    [3, 18],
    [5, 20],
    [10, 27],
    [15, 34],
    [20, 40],
    [24, 48],
    [25, 50],
  ])('level %i -> DC %i', (level, dc) => {
    expect(pf2eLevelBasedDC(level)).toBe(dc);
    expect(Pf2eAdapter.levelBasedDC(level)).toBe(dc);
  });

  it('clamps out-of-range levels to the table ends', () => {
    expect(pf2eLevelBasedDC(-3)).toBe(14);
    expect(pf2eLevelBasedDC(99)).toBe(50);
  });

  it('exposes the simple DC-by-rank table', () => {
    expect(pf2eSimpleDC('untrained')).toBe(10);
    expect(pf2eSimpleDC('trained')).toBe(15);
    expect(pf2eSimpleDC('expert')).toBe(20);
    expect(pf2eSimpleDC('master')).toBe(30);
    expect(pf2eSimpleDC('legendary')).toBe(40);
    expect(Pf2eAdapter.simpleDC('legendary')).toBe(40);
  });
});

describe('Pf2eAdapter — degrees of success', () => {
  it('classifies by margin: crit success at +10, success at par, crit failure at -10', () => {
    expect(pf2eDegreeOfSuccess(30, 20)).toBe('criticalSuccess');
    expect(pf2eDegreeOfSuccess(25, 20)).toBe('success');
    expect(pf2eDegreeOfSuccess(20, 20)).toBe('success');
    expect(pf2eDegreeOfSuccess(19, 20)).toBe('failure');
    expect(pf2eDegreeOfSuccess(11, 20)).toBe('failure');
    expect(pf2eDegreeOfSuccess(10, 20)).toBe('criticalFailure');
    expect(pf2eDegreeOfSuccess(5, 20)).toBe('criticalFailure');
  });

  it('a natural 20 shifts one degree better (but not past critical success)', () => {
    expect(pf2eDegreeOfSuccess(19, 20, 20)).toBe('success'); // failure -> success
    expect(pf2eDegreeOfSuccess(20, 20, 20)).toBe('criticalSuccess'); // success -> crit
    expect(pf2eDegreeOfSuccess(30, 20, 20)).toBe('criticalSuccess'); // already crit, stays
  });

  it('a natural 1 shifts one degree worse (but not past critical failure)', () => {
    expect(pf2eDegreeOfSuccess(25, 20, 1)).toBe('failure'); // success -> failure
    expect(pf2eDegreeOfSuccess(19, 20, 1)).toBe('criticalFailure'); // failure -> crit fail
    expect(pf2eDegreeOfSuccess(5, 20, 1)).toBe('criticalFailure'); // already crit fail, stays
  });

  it('omitting the natural roll compares totals only', () => {
    expect(pf2eDegreeOfSuccess(19, 20, undefined)).toBe('failure');
    expect(Pf2eAdapter.degreeOfSuccess(30, 20)).toBe('criticalSuccess');
  });
});

describe('Pf2eAdapter — condition vocabulary', () => {
  it('is the PF2e (remaster) condition list, distinct from 5e', () => {
    expect(Pf2eAdapter.conditions).toBe(PF2E_CONDITIONS);
    expect(Pf2eAdapter.conditions).toContain('Frightened');
    expect(Pf2eAdapter.conditions).toContain('Clumsy');
    expect(Pf2eAdapter.conditions).toContain('Off-Guard');
    expect(Pf2eAdapter.conditions).toContain('Enfeebled');
    // 5e-only conditions that don't exist in PF2e's vocabulary
    expect(Pf2eAdapter.conditions).not.toContain('Charmed');
    expect(Pf2eAdapter.conditions).not.toContain('Exhaustion');
  });
});

describe('Pf2eAdapter — initiative (Perception, not DEX)', () => {
  it('uses a flat monster Perception modifier as the initiative bonus (level-inclusive)', () => {
    // Stored Perception already includes the creature's level; do not add proficiency again.
    expect(Pf2eAdapter.initiativeModifier({ perception: 27, dexterity: 4 })).toBe(27);
    expect(Pf2eAdapter.initiativeModifier({ perception: 27 }, 'modifier', 14)).toBe(27);
  });

  it('derives from WIS alone when level is unknown (incomplete call)', () => {
    // WIS 16 -> +3; DEX is deliberately ignored (that would be the 5e rule).
    // Without level the proficiency term cannot be computed — callers that have a
    // character sheet must pass level (see the level-5 case below / issue #491).
    expect(Pf2eAdapter.initiativeModifier({ WIS: 16, DEX: 20 })).toBe(3);
    expect(Pf2eAdapter.initiativeModifier({ wisdom: 14 })).toBe(2);
    expect(Pf2eAdapter.initiativeModifier({ WIS: 16 }, 'score')).toBe(3);
  });

  it('adds trained Perception proficiency (level + 2) for a character-sheet WIS fallback (#491)', () => {
    // By-hand PF2e: level-5, WIS 16 → ability +3 + trained proficiency (5+2) = +10.
    // Initiative roll is d20 + that modifier (initiativeDie stays 20).
    expect(Pf2eAdapter.initiativeModifier({ WIS: 16, DEX: 20 }, 'score', 5)).toBe(10);
    expect(Pf2eAdapter.initiativeModifier({ wisdom: 14 }, 'score', 5)).toBe(9); // +2 + 7
    expect(Pf2eAdapter.initiativeModifier({ WIS: 10 }, 'score', 1)).toBe(3); // +0 + (1+2)
    // Matches pf2eProficiencyBonus(level, 'trained') composition.
    expect(Pf2eAdapter.initiativeModifier({ WIS: 16 }, 'score', 5)).toBe(
      Pf2eAdapter.abilityModifier(16) + Pf2eAdapter.proficiencyBonus(5, 'trained'),
    );
  });

  it('does not add proficiency on the creature modifier path even when level is passed', () => {
    // wisdom: 5 is a PF2e creature mod (+5), not a score of 5 (which would become -3).
    expect(Pf2eAdapter.initiativeModifier({ wisdom: 5 }, 'modifier')).toBe(5);
    expect(Pf2eAdapter.initiativeModifier({ wisdom: 5 }, 'modifier', 14)).toBe(5);
    expect(Pf2eAdapter.initiativeModifier({ wisdom: 0 }, 'modifier')).toBe(0);
    expect(Pf2eAdapter.initiativeModifier({ wisdom: -1 }, 'modifier')).toBe(-1);
    expect(Pf2eAdapter.initiativeModifier({ wisdom: 12 }, 'modifier')).toBe(12);
  });

  it('returns 0 when no Perception/WIS is present', () => {
    expect(Pf2eAdapter.initiativeModifier({ STR: 18 })).toBe(0);
    expect(Pf2eAdapter.initiativeModifier({ STR: 18 }, 'score', 5)).toBe(0);
    expect(Pf2eAdapter.initiativeModifier(null)).toBe(0);
    expect(Pf2eAdapter.initiativeModifier(undefined)).toBe(0);
  });

  it('rolls initiative on a d20', () => {
    expect(Pf2eAdapter.initiativeDie).toBe(20);
  });
});

describe('Pf2eAdapter — initiativeTiebreak (issue #611)', () => {
  it('preserves sortOrder / roll order and ignores initMod on a tie', () => {
    // Higher initMod on b must NOT reorder ahead of a — PF2e keeps add/roll order.
    expect(
      Pf2eAdapter.initiativeTiebreak(
        { initMod: 1, sortOrder: 0 },
        { initMod: 9, sortOrder: 1 },
      ),
    ).toBeLessThan(0);
    expect(
      Pf2eAdapter.initiativeTiebreak(
        { initMod: 9, sortOrder: 1 },
        { initMod: 1, sortOrder: 0 },
      ),
    ).toBeGreaterThan(0);
  });

  it('is inherited by Sf2eAdapter (same preserved-order rule)', () => {
    expect(Sf2eAdapter.initiativeTiebreak).toBe(Pf2eAdapter.initiativeTiebreak);
  });
});

describe('Pf2eAdapter — statblock mapping', () => {
  const data = {
    level: 14,
    ac: 37,
    hp: 300,
    perception: 27,
    abilityMods: { strength: 9, dexterity: 4, wisdom: 5 },
    saves: { fortitude: 27, reflex: 24, will: 25 },
    size: 'Huge',
    traits: ['Dragon', 'Fire'],
    speed: { walk: 40, fly: 120 },
  };

  it('maps PF2e level into the CR slot, ac->armorClass, hp->hitPoints, traits->creatureType', () => {
    const mapped = Pf2eAdapter.mapStatblock(data);
    expect(mapped.challengeRating).toBe(14);
    expect(mapped.armorClass).toBe(37);
    expect(mapped.hitPoints).toBe(300);
    expect(mapped.creatureType).toBe('Dragon, Fire');
    expect(mapped.size).toBe('Huge');
  });

  it('surfaces ability MODS as abilityScores with modifier representation and folds in Perception', () => {
    const mapped = Pf2eAdapter.mapStatblock(data);
    expect(mapped.abilityRepresentation).toBe('modifier');
    expect(mapped.abilityScores).toEqual({ strength: 9, dexterity: 4, wisdom: 5, perception: 27 });
    // Combat path passes representation so modifiers are consumed exactly once; Perception wins.
    expect(Pf2eAdapter.initiativeModifier(mapped.abilityScores, mapped.abilityRepresentation)).toBe(27);
  });

  it('keeps zero / negative / positive / double-digit creature mods intact through the map', () => {
    const mapped = Pf2eAdapter.mapStatblock({
      level: 1,
      abilityMods: { strength: 0, dexterity: 3, wisdom: -1, charisma: 12 },
      perception: 4,
    });
    expect(mapped.abilityRepresentation).toBe('modifier');
    expect(mapped.abilityScores).toMatchObject({ strength: 0, dexterity: 3, wisdom: -1, charisma: 12, perception: 4 });
    expect(Pf2eAdapter.initiativeModifier(mapped.abilityScores, mapped.abilityRepresentation)).toBe(4);
  });

  it('resolves monster max HP (rounded), or null when unavailable/non-positive', () => {
    expect(Pf2eAdapter.monsterHitPoints({ hp: 300 })).toBe(300);
    expect(Pf2eAdapter.monsterHitPoints({ hitPoints: 10.6 })).toBe(11);
    expect(Pf2eAdapter.monsterHitPoints({ hp: 0 })).toBeNull();
    expect(Pf2eAdapter.monsterHitPoints({})).toBeNull();
    expect(Pf2eAdapter.monsterHitPoints({ hp: 'lots' })).toBeNull();
  });
});

/**
 * Issue #2150 — PF2e monster defences parsed best-effort because Pf2eAdapter declared no
 * damageTypes vocabulary. An AoN `immunity: ['fire','paralyzed','sleep']` registered the two
 * CONDITIONS as damage immunities, and a resolvable spec carrying "slashing damage" sailed
 * past a slashing resistance. Declaring the vocabulary fixes both, but a naive list of the 16
 * types would silently drop the category-shaped entries PF2e prints ("resistance 5 physical",
 * "all damage") that are real defences — so the adapter also declares `damageTypeCategories`,
 * which the parser expands to plain members at parse time.
 */
describe('Pf2eAdapter — damage-type vocabulary (#2150)', () => {
  it('declares the plain 16 Player Core damage types, distinct from 5e', () => {
    expect(Pf2eAdapter.damageTypes).toBe(PF2E_DAMAGE_TYPES);
    // The 16 grouped the way Player Core groups them.
    for (const type of [
      'bludgeoning', 'piercing', 'slashing',
      'acid', 'cold', 'electricity', 'fire', 'force', 'sonic', 'vitality', 'void',
      'mental', 'poison', 'bleed', 'precision', 'spirit',
    ]) {
      expect(Pf2eAdapter.damageTypes).toContain(type);
    }
    expect(Pf2eAdapter.damageTypes).toHaveLength(16);
    // PF2e does NOT carry 5e's renamed/absent types — these would silently fail to match a
    // real PF2e defence if they leaked in.
    for (const dnd5eOnly of ['lightning', 'thunder', 'necrotic', 'radiant', 'psychic']) {
      expect(Pf2eAdapter.damageTypes).not.toContain(dnd5eOnly);
    }
    // "Untyped" is the ABSENCE of a type, never a selectable one.
    expect(Pf2eAdapter.damageTypes).not.toContain('untyped');
  });

  it('is the list the damage-type picker and the direct-damage check read — no category words', () => {
    // Both consumers (BattleMap picker + EncountersService direct-damage type check) read
    // `damageTypes` directly, so a DM selects "slashing", never the category "physical".
    for (const category of Object.keys(PF2E_DAMAGE_TYPE_CATEGORIES)) {
      expect(Pf2eAdapter.damageTypes).not.toContain(category);
    }
    // Sanity: the 5e list is a different vocabulary (no overlap on the renamed types).
    expect(DND5E_DAMAGE_TYPES).not.toEqual(PF2E_DAMAGE_TYPES);
  });

  it('declares the category map physical/energy/all-damage expand to plain members', () => {
    expect(Pf2eAdapter.damageTypeCategories).toBe(PF2E_DAMAGE_TYPE_CATEGORIES);
    expect(PF2E_DAMAGE_TYPE_CATEGORIES.physical).toEqual(['bludgeoning', 'piercing', 'slashing']);
    // Every category fans out to members that are themselves in the plain vocabulary, so a
    // canonical parse keeps the expanded defence rather than dropping it.
    for (const members of Object.values(PF2E_DAMAGE_TYPE_CATEGORIES)) {
      for (const member of members) {
        expect(PF2E_DAMAGE_TYPES).toContain(member);
      }
    }
    // "all damage" / "all" cover the full plain list.
    expect(PF2E_DAMAGE_TYPE_CATEGORIES['all damage']).toEqual(PF2E_DAMAGE_TYPES);
    expect(PF2E_DAMAGE_TYPE_CATEGORIES.all).toEqual(PF2E_DAMAGE_TYPES);
  });

  it('SF2e inherits both the vocabulary and the categories (it spreads Pf2eAdapter)', () => {
    expect(Sf2eAdapter.damageTypes).toBe(PF2E_DAMAGE_TYPES);
    expect(Sf2eAdapter.damageTypeCategories).toBe(PF2E_DAMAGE_TYPE_CATEGORIES);
  });
});

describe('damageDefensesFromStatblock — PF2e shapes (#2150)', () => {
  // The exact AoN shape: an immunity ARRAY that mixes one damage type with conditions.
  it('drops conditions from an immunity list, keeping only canonical damage types', () => {
    const defenses = damageDefensesFromStatblock(
      { immunities: ['fire', 'paralyzed', 'sleep'] },
      PF2E_DAMAGE_TYPES,
      PF2E_DAMAGE_TYPE_CATEGORIES,
    );
    expect(defenses.immunities).toEqual(['fire']);
    expect(defenses.resistances).toEqual([]);
    // Without a vocabulary the same list is taken verbatim (the bug this issue fixes).
    const bestEffort = damageDefensesFromStatblock({ immunities: ['fire', 'paralyzed', 'sleep'] });
    expect(bestEffort.immunities).toEqual(['fire', 'paralyzed', 'sleep']);
  });

  it('expands a "physical" category immunity to its three member types', () => {
    const defenses = damageDefensesFromStatblock(
      { immunities: ['physical'] },
      PF2E_DAMAGE_TYPES,
      PF2E_DAMAGE_TYPE_CATEGORIES,
    );
    expect(defenses.immunities).toEqual(['bludgeoning', 'piercing', 'slashing']);
  });

  it('expands "all damage" to every plain type, so a slashing Strike lands on the resistance', () => {
    const defenses = damageDefensesFromStatblock(
      { resistances: ['all damage'] },
      PF2E_DAMAGE_TYPES,
      PF2E_DAMAGE_TYPE_CATEGORIES,
    );
    expect(defenses.resistances).toEqual([...PF2E_DAMAGE_TYPES]);
    // The expansion is what makes the exact-match defence apply to a typed attack.
    expect(defenses.resistances).toContain('slashing');
    expect(defenses.resistances).toContain('mental');
  });

  it('expands a record-form "physical" resistance the same way a string clause does', () => {
    const defenses = damageDefensesFromStatblock(
      { resistances: [{ name: 'Physical', key: 'physical' }] },
      PF2E_DAMAGE_TYPES,
      PF2E_DAMAGE_TYPE_CATEGORIES,
    );
    expect(defenses.resistances).toEqual(['bludgeoning', 'piercing', 'slashing']);
  });

  it('keeps a category alongside a plain type and drops a non-vocabulary token in the same clause', () => {
    // "physical, fire" → bludgeoning + piercing + slashing + fire; a trailing "ichor" (not a
    // type, not a category) takes the whole clause down with it, exactly as 5e treats a clause
    // whose entries are not all canonical.
    const kept = damageDefensesFromStatblock(
      { resistances: ['physical, fire'] },
      PF2E_DAMAGE_TYPES,
      PF2E_DAMAGE_TYPE_CATEGORIES,
    );
    expect(kept.resistances).toEqual(['bludgeoning', 'piercing', 'slashing', 'fire']);
    const dropped = damageDefensesFromStatblock(
      { resistances: ['physical, ichor'] },
      PF2E_DAMAGE_TYPES,
      PF2E_DAMAGE_TYPE_CATEGORIES,
    );
    expect(dropped.resistances).toEqual([]);
  });

  it('leaves a system without categories on the literal-membership behaviour (5e unchanged)', () => {
    // 5e has no `damageTypeCategories`, so a "physical" resistance is still dropped under its
    // vocabulary — the category expansion is PF2e's, not a behaviour change for every system.
    const dnd5e = damageDefensesFromStatblock({ resistances: ['physical'] }, DND5E_DAMAGE_TYPES);
    expect(dnd5e.resistances).toEqual([]);
    const dnd5eKept = damageDefensesFromStatblock({ resistances: ['fire'] }, DND5E_DAMAGE_TYPES);
    expect(dnd5eKept.resistances).toEqual(['fire']);
  });
});
