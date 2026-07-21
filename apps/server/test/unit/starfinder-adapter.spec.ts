import {
  StarfinderAdapter,
  STARFINDER_ADAPTER_ID,
  STARFINDER_CONDITIONS,
  starfinderArmorClasses,
  starfinderHitPoints,
  ruleSystemAdapter,
  Dnd5eAdapter,
} from '@campfire/schema';

/**
 * Unit tests for the Starfinder 1e RuleSystemAdapter (issue #297). Starfinder reuses the
 * d20 ability-modifier + DEX-derived d20 initiative from the shared base; the tests below
 * pin the two Starfinder-specific wrinkles — the Stamina + Hit Points damage-pool split and
 * the EAC/KAC dual armor class — plus the condition vocabulary and registry resolution.
 */
describe('StarfinderAdapter — abilityModifier (shared d20 formula)', () => {
  it.each([
    [1, -5],
    [8, -1],
    [10, 0],
    [11, 0],
    [16, 3],
    [18, 4],
    [20, 5],
  ])('score %i -> modifier %i (floor((score-10)/2))', (score, mod) => {
    expect(StarfinderAdapter.abilityModifier(score)).toBe(mod);
  });
});

describe('StarfinderAdapter — initiative derivation (DEX on a d20)', () => {
  it('uses a d20 for the initiative die', () => {
    expect(StarfinderAdapter.initiativeDie).toBe(20);
  });

  it('derives the init modifier from the DEX key (canonical stats)', () => {
    expect(StarfinderAdapter.initiativeModifier({ STR: 10, DEX: 16, CON: 11 })).toBe(3);
    expect(StarfinderAdapter.initiativeModifier({ DEX: 7 })).toBe(-2);
  });

  it('derives the init modifier from a raw alien abilityScores object (dexterity key)', () => {
    expect(StarfinderAdapter.initiativeModifier({ strength: 8, dexterity: 18 })).toBe(4);
  });

  it('returns 0 when DEX is absent or non-numeric', () => {
    expect(StarfinderAdapter.initiativeModifier({ STR: 16 })).toBe(0);
    expect(StarfinderAdapter.initiativeModifier({ DEX: 'nope' as unknown as number })).toBe(0);
    expect(StarfinderAdapter.initiativeModifier({})).toBe(0);
    expect(StarfinderAdapter.initiativeModifier(null)).toBe(0);
    expect(StarfinderAdapter.initiativeModifier(undefined)).toBe(0);
  });
});

describe('StarfinderAdapter — Stamina + Hit Points split', () => {
  it('combines Stamina and HP into the effective damage pool (a class-leveled combatant)', () => {
    // Soldier with SP 21 + HP 20 → 41 effective HP for the combat tracker.
    expect(starfinderHitPoints({ stamina: 21, hitPoints: 20 })).toEqual({ stamina: 21, hitPoints: 20, total: 41 });
    expect(StarfinderAdapter.monsterHitPoints({ stamina: 21, hitPoints: 20 })).toBe(41);
  });

  it('falls back to HP-only for a plain alien with no Stamina', () => {
    // Ksarik (CR 2): HP 25, no Stamina → 25.
    expect(starfinderHitPoints({ hit_points: 25 })).toEqual({ stamina: 0, hitPoints: 25, total: 25 });
    expect(StarfinderAdapter.monsterHitPoints({ hit_points: 25 })).toBe(25);
  });

  it('accepts snake_case, camelCase, and short keys and numeric strings; rounds', () => {
    expect(starfinderHitPoints({ stamina_points: '10', hp: 12.6 })).toEqual({ stamina: 10, hitPoints: 13, total: 23 });
    expect(starfinderHitPoints({ sp: 5, hitPoints: 5 }).total).toBe(10);
  });

  it('returns null max HP when the pool is empty / non-positive / non-numeric', () => {
    expect(StarfinderAdapter.monsterHitPoints({})).toBeNull();
    expect(StarfinderAdapter.monsterHitPoints({ hitPoints: 0, stamina: 0 })).toBeNull();
    expect(StarfinderAdapter.monsterHitPoints({ hitPoints: 'lots' })).toBeNull();
  });
});

describe('StarfinderAdapter — EAC / KAC dual armor class', () => {
  it('reads both armor classes off a statblock', () => {
    // Space Goblin Zaperator: EAC 10, KAC 12.
    expect(starfinderArmorClasses({ eac: 10, kac: 12 })).toEqual({ eac: 10, kac: 12 });
    expect(StarfinderAdapter.armorClasses({ eac: 13, kac: 15 })).toEqual({ eac: 13, kac: 15 });
  });

  it('tolerates snake_case / long key names and numeric strings', () => {
    expect(starfinderArmorClasses({ energy_armor_class: '11', kinetic_armor_class: '13' })).toEqual({ eac: 11, kac: 13 });
  });

  it('treats a generic armorClass as KAC (physical AC) when no explicit kac is present', () => {
    expect(starfinderArmorClasses({ eac: 12, armorClass: 14 })).toEqual({ eac: 12, kac: 14 });
  });

  it('returns null for a missing AC rather than 0', () => {
    expect(starfinderArmorClasses({})).toEqual({ eac: null, kac: null });
  });
});

describe('StarfinderAdapter — statblock mapping', () => {
  it('maps KAC into the generic armorClass slot and SP+HP into the generic hitPoints slot', () => {
    const mapped = StarfinderAdapter.mapStatblock({
      size: 'Small',
      type: 'humanoid',
      cr: '1/3',
      eac: 10,
      kac: 12,
      stamina: 0,
      hit_points: 6,
      speed: { land: 35 },
      ability_scores: { dexterity: 16 },
    });
    expect(mapped.creatureType).toBe('humanoid');
    expect(mapped.challengeRating).toBe('1/3');
    expect(mapped.armorClass).toBe(12); // KAC in the generic slot
    expect(mapped.hitPoints).toBe(6); // SP(0) + HP(6)
    // Starfinder-specific widened fields still available for sci-fi-aware surfaces.
    expect(mapped.eac).toBe(10);
    expect(mapped.kac).toBe(12);
    expect(mapped.abilityScores).toEqual({ dexterity: 16 });
  });

  it('sums Stamina and HP for a class-leveled combatant', () => {
    const mapped = StarfinderAdapter.mapStatblock({ stamina: 21, hitPoints: 20, eac: 16, kac: 18 });
    expect(mapped.hitPoints).toBe(41);
    expect(mapped.armorClass).toBe(18);
  });
});

describe('StarfinderAdapter — condition vocabulary', () => {
  it('exposes the Starfinder condition list', () => {
    expect(StarfinderAdapter.conditions).toBe(STARFINDER_CONDITIONS);
  });

  it('includes Starfinder-specific conditions and excludes 5e-only ones', () => {
    expect(STARFINDER_CONDITIONS).toEqual(expect.arrayContaining(['Off-Kilter', 'Off-Target', 'Flat-Footed', 'Broken']));
    expect(STARFINDER_CONDITIONS).not.toContain('Petrified');
    expect(STARFINDER_CONDITIONS).not.toContain('Charmed');
  });
});

describe('StarfinderAdapter — registry resolution', () => {
  it('has the expected family id/label', () => {
    expect(StarfinderAdapter.id).toBe('starfinder-1e');
    expect(STARFINDER_ADAPTER_ID).toBe('starfinder-1e');
    expect(StarfinderAdapter.label).toBe('Starfinder 1e');
  });

  it('resolves the Starfinder adapter for a campaign on the Starfinder rule system', () => {
    expect(ruleSystemAdapter(STARFINDER_ADAPTER_ID)).toBe(StarfinderAdapter);
  });

  it('does NOT change the 5e default for other rule systems', () => {
    expect(ruleSystemAdapter('open5e-srd')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(null)).toBe(Dnd5eAdapter);
  });
});
