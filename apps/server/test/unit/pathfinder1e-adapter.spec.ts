import {
  Dnd5eAdapter,
  Pathfinder1eAdapter,
  PF1E_ADAPTER_ID,
  PF1E_PACK_SLUG,
  PF1E_CONDITIONS,
  ruleSystemAdapter,
  pf1eAbilityModifier,
  pf1eBaseSaveBonus,
  pf1eBaseAttackBonus,
  pf1eSavingThrow,
  pf1eArmorClass,
} from '@campfire/schema';

/**
 * Unit tests for the Pathfinder 1e RuleSystemAdapter (issue #296). PF1e is 3.5e-derived, so
 * the shared-interface pieces (ability modifier, DEX-derived d20 initiative, ascending-AC
 * statblock mapping, HP resolution) mirror the 5e adapter, while the PF-specific 3.5e-family
 * math — good/poor save tracks, full/three-quarter/half BAB progressions, and the additive
 * ascending-AC breakdown — is verified against the Pathfinder Core Rulebook (OGL) tables.
 */
describe('Pathfinder1eAdapter — abilityModifier (floor((score-10)/2), same as 3.5e/5e)', () => {
  it.each([
    [1, -5],
    [7, -2],
    [8, -1],
    [10, 0],
    [11, 0],
    [12, 1],
    [15, 2],
    [18, 4],
    [20, 5],
    [30, 10],
  ])('score %i -> modifier %i', (score, mod) => {
    expect(Pathfinder1eAdapter.abilityModifier(score)).toBe(mod);
    expect(pf1eAbilityModifier(score)).toBe(mod);
  });

  it('matches the 5e adapter exactly (identical formula)', () => {
    for (let s = 1; s <= 30; s++) {
      expect(Pathfinder1eAdapter.abilityModifier(s)).toBe(Dnd5eAdapter.abilityModifier(s));
    }
  });
});

describe('Pathfinder1eAdapter — initiative (DEX-derived d20)', () => {
  it('rolls a d20 for initiative', () => {
    expect(Pathfinder1eAdapter.initiativeDie).toBe(20);
  });

  it('derives the init modifier from canonical character stats (DEX key)', () => {
    expect(Pathfinder1eAdapter.initiativeModifier({ STR: 10, DEX: 14, CON: 12 })).toBe(2);
    expect(Pathfinder1eAdapter.initiativeModifier({ DEX: 7 })).toBe(-2);
  });

  it('derives the init modifier from a raw monster abilityScores object (dexterity key)', () => {
    expect(Pathfinder1eAdapter.initiativeModifier({ strength: 11, dexterity: 15, constitution: 12 })).toBe(2);
  });

  it('returns 0 when the governing (DEX) score is absent or non-numeric', () => {
    expect(Pathfinder1eAdapter.initiativeModifier({ STR: 16 })).toBe(0);
    expect(Pathfinder1eAdapter.initiativeModifier({ DEX: 'nope' as unknown as number })).toBe(0);
    expect(Pathfinder1eAdapter.initiativeModifier({})).toBe(0);
    expect(Pathfinder1eAdapter.initiativeModifier(null)).toBe(0);
    expect(Pathfinder1eAdapter.initiativeModifier(undefined)).toBe(0);
  });
});

describe('Pathfinder1eAdapter — save progressions (good/poor tracks)', () => {
  // PF1e Core Rulebook base-save-bonus table by level.
  it.each([
    [1, 2],
    [2, 3],
    [3, 3],
    [4, 4],
    [10, 7],
    [20, 12],
  ])('good save at level %i is +%i (floor(level/2)+2)', (level, bonus) => {
    expect(pf1eBaseSaveBonus(level, 'good')).toBe(bonus);
  });

  it.each([
    [1, 0],
    [2, 0],
    [3, 1],
    [6, 2],
    [10, 3],
    [20, 6],
  ])('poor save at level %i is +%i (floor(level/3))', (level, bonus) => {
    expect(pf1eBaseSaveBonus(level, 'poor')).toBe(bonus);
  });

  it('composes a full saving throw as base track bonus + governing ability modifier', () => {
    // Level 5 fighter, good Fort track (+4), CON 14 (+2) -> Fort +6.
    expect(pf1eSavingThrow(5, 'good', 14)).toBe(6);
    // Level 5 fighter, poor Will track (+1), WIS 8 (-1) -> Will +0.
    expect(pf1eSavingThrow(5, 'poor', 8)).toBe(0);
  });

  it('clamps a non-positive/fractional level to a floored, non-negative level', () => {
    expect(pf1eBaseSaveBonus(0, 'good')).toBe(2);
    expect(pf1eBaseSaveBonus(-3, 'poor')).toBe(0);
    expect(pf1eBaseSaveBonus(4.9, 'good')).toBe(4);
  });
});

describe('Pathfinder1eAdapter — Base Attack Bonus progressions', () => {
  it.each([
    [1, 1],
    [5, 5],
    [20, 20],
  ])('full BAB at level %i is +%i', (level, bab) => {
    expect(pf1eBaseAttackBonus(level, 'full')).toBe(bab);
  });

  it.each([
    [1, 0],
    [2, 1],
    [4, 3],
    [5, 3],
    [20, 15],
  ])('three-quarter BAB at level %i is +%i (floor(level*3/4))', (level, bab) => {
    expect(pf1eBaseAttackBonus(level, 'threeQuarter')).toBe(bab);
  });

  it.each([
    [1, 0],
    [2, 1],
    [3, 1],
    [4, 2],
    [20, 10],
  ])('half BAB at level %i is +%i (floor(level/2))', (level, bab) => {
    expect(pf1eBaseAttackBonus(level, 'half')).toBe(bab);
  });
});

describe('Pathfinder1eAdapter — ascending Armor Class', () => {
  it('is 10 + DEX modifier + summed AC bonuses (higher is better)', () => {
    // 10 + DEX(+2, from 14) + armor 4 + shield 2 + natural 1 = 19
    expect(pf1eArmorClass({ dexScore: 14, armor: 4, shield: 2, natural: 1 })).toBe(19);
  });

  it('defaults omitted components to 0 and a missing DEX to +0', () => {
    expect(pf1eArmorClass({})).toBe(10);
    expect(pf1eArmorClass({ armor: 8 })).toBe(18);
  });

  it('applies a negative size modifier and negative DEX modifier', () => {
    // Large creature: size -1, DEX 9 (-1), natural 5 -> 10 -1 -1 +5 = 13
    expect(pf1eArmorClass({ dexScore: 9, natural: 5, size: -1 })).toBe(13);
  });
});

describe('Pathfinder1eAdapter — condition vocabulary', () => {
  it('exposes the PF1e condition list (larger than 5e)', () => {
    expect(Pathfinder1eAdapter.conditions).toBe(PF1E_CONDITIONS);
    expect(Pathfinder1eAdapter.conditions.length).toBeGreaterThan(30);
  });

  it('includes PF1e-only states absent from 5e (dying/disabled/staggered/entangled/…)', () => {
    for (const c of ['Bleed', 'Dying', 'Disabled', 'Staggered', 'Entangled', 'Sickened', 'Cowering', 'Dazzled', 'Flat-Footed']) {
      expect(Pathfinder1eAdapter.conditions).toContain(c);
    }
  });
});

describe('Pathfinder1eAdapter — statblock mapping', () => {
  it('maps PF1e-SRD snake_case statblock fields (ascending AC kept as-is)', () => {
    const mapped = Pathfinder1eAdapter.mapStatblock({
      size: 'Small',
      type: 'humanoid',
      cr: '1/3',
      ac: 16,
      hp: 6,
      speed: 30,
      ability_scores: { strength: 11, dexterity: 15 },
    });
    expect(mapped.creatureType).toBe('humanoid');
    expect(mapped.challengeRating).toBe('1/3');
    expect(mapped.armorClass).toBe(16);
    expect(mapped.hitPoints).toBe(6);
    expect(mapped.abilityScores).toEqual({ strength: 11, dexterity: 15 });
  });

  it('also accepts camelCase (stored) fields', () => {
    const mapped = Pathfinder1eAdapter.mapStatblock({
      size: 'Large',
      creatureType: 'dragon',
      challengeRating: 10,
      armorClass: 24,
      hitPoints: 115,
      abilityScores: { dexterity: 10 },
    });
    expect(mapped.creatureType).toBe('dragon');
    expect(mapped.challengeRating).toBe(10);
    expect(mapped.armorClass).toBe(24);
    expect(mapped.hitPoints).toBe(115);
  });

  it('resolves monster max HP (rounded), or null when unavailable/non-positive', () => {
    expect(Pathfinder1eAdapter.monsterHitPoints({ hp: 59 })).toBe(59);
    expect(Pathfinder1eAdapter.monsterHitPoints({ hit_points: 10.6 })).toBe(11);
    expect(Pathfinder1eAdapter.monsterHitPoints({ hitPoints: 7 })).toBe(7);
    expect(Pathfinder1eAdapter.monsterHitPoints({ hp: 0 })).toBeNull();
    expect(Pathfinder1eAdapter.monsterHitPoints({ hp: -3 })).toBeNull();
    expect(Pathfinder1eAdapter.monsterHitPoints({})).toBeNull();
    expect(Pathfinder1eAdapter.monsterHitPoints({ hp: 'lots' })).toBeNull();
  });
});

describe('Pathfinder1eAdapter — registry resolution (issue #296 registration)', () => {
  it('resolves the PF1e adapter for a campaign whose ruleSystem is the PF1e pack slug', () => {
    expect(ruleSystemAdapter(PF1E_PACK_SLUG)).toBe(Pathfinder1eAdapter);
    expect(ruleSystemAdapter('pathfinder-1e')).toBe(Pathfinder1eAdapter);
  });

  it('exposes a stable family id equal to the pack slug', () => {
    expect(Pathfinder1eAdapter.id).toBe(PF1E_ADAPTER_ID);
    expect(PF1E_ADAPTER_ID).toBe('pathfinder-1e');
    expect(PF1E_PACK_SLUG).toBe('pathfinder-1e');
  });

  it('does NOT disturb the 5e default for other/empty rule systems', () => {
    expect(ruleSystemAdapter('open5e-srd')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(null)).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(undefined)).toBe(Dnd5eAdapter);
  });
});
