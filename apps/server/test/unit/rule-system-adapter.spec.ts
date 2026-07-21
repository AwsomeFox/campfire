import { Dnd5eAdapter, DND5E_ADAPTER_ID, ruleSystemAdapter, CONDITIONS } from '@campfire/schema';

/**
 * Unit tests for the RuleSystemAdapter seam (issue #70). The 5e adapter captures the
 * previously-hardcoded 5e decisions — ability modifier, DEX-derived initiative, the d20
 * initiative die, the condition vocabulary, and the monster-statblock field mapping — and
 * the registry resolves it as the default for any campaign. These assert the seam produces
 * byte-for-byte the same values the inline 5e logic did.
 */
describe('RuleSystemAdapter — Dnd5eAdapter.abilityModifier', () => {
  it.each([
    [1, -5],
    [3, -4],
    [8, -1],
    [9, -1],
    [10, 0],
    [11, 0],
    [12, 1],
    [14, 2],
    [15, 2],
    [20, 5],
    [30, 10],
  ])('score %i -> modifier %i (floor((score-10)/2))', (score, mod) => {
    expect(Dnd5eAdapter.abilityModifier(score)).toBe(mod);
  });
});

describe('RuleSystemAdapter — 5e initiative derivation', () => {
  it('uses a d20 for the initiative die', () => {
    expect(Dnd5eAdapter.initiativeDie).toBe(20);
  });

  it('derives the init modifier from canonical character stats (DEX key)', () => {
    expect(Dnd5eAdapter.initiativeModifier({ STR: 10, DEX: 14, CON: 12 })).toBe(2);
    expect(Dnd5eAdapter.initiativeModifier({ DEX: 7 })).toBe(-2);
  });

  it('derives the init modifier from a raw monster abilityScores object (dexterity key)', () => {
    expect(Dnd5eAdapter.initiativeModifier({ strength: 16, dexterity: 18, constitution: 14 })).toBe(4);
  });

  it('returns 0 when the governing (DEX) score is absent or non-numeric', () => {
    expect(Dnd5eAdapter.initiativeModifier({ STR: 16 })).toBe(0);
    expect(Dnd5eAdapter.initiativeModifier({ DEX: 'nope' as unknown as number })).toBe(0);
    expect(Dnd5eAdapter.initiativeModifier({})).toBe(0);
    expect(Dnd5eAdapter.initiativeModifier(null)).toBe(0);
    expect(Dnd5eAdapter.initiativeModifier(undefined)).toBe(0);
  });
});

describe('RuleSystemAdapter — 5e condition vocabulary', () => {
  it('is the canonical schema CONDITIONS list (single source of truth, issue #234)', () => {
    expect(Dnd5eAdapter.conditions).toEqual(CONDITIONS);
  });
});

describe('RuleSystemAdapter — 5e statblock mapping', () => {
  it('maps camelCase (stored/importer) statblock fields', () => {
    const mapped = Dnd5eAdapter.mapStatblock({
      size: 'Large',
      type: 'dragon',
      challengeRating: 5,
      armorClass: 17,
      hitPoints: 84,
      speed: 40,
      abilityScores: { dexterity: 14 },
      specialAbilities: [{ name: 'Keen Sight', desc: '...' }],
      actions: [{ name: 'Bite', desc: '...' }],
    });
    expect(mapped.creatureType).toBe('dragon');
    expect(mapped.challengeRating).toBe(5);
    expect(mapped.armorClass).toBe(17);
    expect(mapped.hitPoints).toBe(84);
    expect(mapped.abilityScores).toEqual({ dexterity: 14 });
  });

  it('falls back to snake_case / short raw-Open5e keys', () => {
    const mapped = Dnd5eAdapter.mapStatblock({
      creatureType: 'beast',
      challenge_rating: '1/4',
      armor_class: 13,
      hit_points: 22,
      ability_scores: { dexterity: 12 },
      special_abilities: [{ name: 'Pack Tactics', desc: '...' }],
    });
    expect(mapped.creatureType).toBe('beast');
    expect(mapped.challengeRating).toBe('1/4');
    expect(mapped.armorClass).toBe(13);
    expect(mapped.hitPoints).toBe(22);
    expect(mapped.abilityScores).toEqual({ dexterity: 12 });
  });

  it('resolves a monster max HP (rounded), or null when unavailable/non-positive', () => {
    expect(Dnd5eAdapter.monsterHitPoints({ hitPoints: 45 })).toBe(45);
    expect(Dnd5eAdapter.monsterHitPoints({ hit_points: 10.6 })).toBe(11);
    expect(Dnd5eAdapter.monsterHitPoints({ hp: 7 })).toBe(7);
    expect(Dnd5eAdapter.monsterHitPoints({ hitPoints: 0 })).toBeNull();
    expect(Dnd5eAdapter.monsterHitPoints({ hitPoints: -3 })).toBeNull();
    expect(Dnd5eAdapter.monsterHitPoints({})).toBeNull();
    expect(Dnd5eAdapter.monsterHitPoints({ hitPoints: 'lots' })).toBeNull();
  });
});

describe('RuleSystemAdapter — registry resolution', () => {
  it('resolves the default (5e) adapter for a normal campaign rule-pack slug', () => {
    expect(ruleSystemAdapter('open5e-srd')).toBe(Dnd5eAdapter);
  });

  it('resolves the 5e adapter for empty / null / undefined ruleSystem', () => {
    expect(ruleSystemAdapter('')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(null)).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(undefined)).toBe(Dnd5eAdapter);
  });

  it('resolves the 5e adapter by its family id', () => {
    expect(ruleSystemAdapter(DND5E_ADAPTER_ID)).toBe(Dnd5eAdapter);
    expect(Dnd5eAdapter.id).toBe('dnd5e');
  });

  it('falls back to 5e for an unrecognized rule system (no second system yet)', () => {
    expect(ruleSystemAdapter('pathfinder-2e')).toBe(Dnd5eAdapter);
  });
});
