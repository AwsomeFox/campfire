import {
  Dnd5eAdapter,
  DND5E_ADAPTER_ID,
  ruleSystemAdapter,
  listRuleSystemAdapters,
  hasDeathSavesForAdapter,
  initiativeModelForAdapter,
  gridDistanceForAdapter,
  actionEconomyForAdapter,
  CONDITIONS,
  isKnownCondition,
  Pf2eAdapter,
  OpenLegendAdapter,
  OPEN_LEGEND_ADAPTER_ID,
  OPEN_LEGEND_PACK_SLUG,
  Pathfinder1eAdapter,
  StarfinderAdapter,
  Archmage13aAdapter,
  OsrAdapter,
  xpProgressForCharacter,
  xpProgressionFromThresholds,
  xpProgressionSupported,
} from '@campfire/schema';

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

describe('RuleSystemAdapter — 5e initiativeTiebreak (issue #611)', () => {
  it('orders higher initMod (DEX) before lower on a tie', () => {
    expect(
      Dnd5eAdapter.initiativeTiebreak(
        { initMod: 1, sortOrder: 0 },
        { initMod: 3, sortOrder: 1 },
      ),
    ).toBeGreaterThan(0);
    expect(
      Dnd5eAdapter.initiativeTiebreak(
        { initMod: 4, sortOrder: 5 },
        { initMod: 2, sortOrder: 0 },
      ),
    ).toBeLessThan(0);
  });

  it('falls back to sortOrder ascending when initMod is equal (stable / no roll-off UI)', () => {
    expect(
      Dnd5eAdapter.initiativeTiebreak(
        { initMod: 2, sortOrder: 0 },
        { initMod: 2, sortOrder: 3 },
      ),
    ).toBeLessThan(0);
    expect(
      Dnd5eAdapter.initiativeTiebreak(
        { initMod: 2, sortOrder: 3 },
        { initMod: 2, sortOrder: 0 },
      ),
    ).toBeGreaterThan(0);
  });
});

describe('RuleSystemAdapter — 5e condition vocabulary', () => {
  it('is the canonical schema CONDITIONS list (single source of truth, issue #234)', () => {
    expect(Dnd5eAdapter.conditions).toEqual(CONDITIONS);
  });
});

describe('isKnownCondition (issue #495)', () => {
  it('matches adapter vocabulary case-insensitively and rejects arbitrary labels', () => {
    expect(isKnownCondition(Dnd5eAdapter.conditions, 'Prone')).toBe(true);
    expect(isKnownCondition(Dnd5eAdapter.conditions, 'prone')).toBe(true);
    expect(isKnownCondition(Dnd5eAdapter.conditions, '  POISONED  ')).toBe(true);
    expect(isKnownCondition(Dnd5eAdapter.conditions, 'god_mode')).toBe(false);
    expect(isKnownCondition(Dnd5eAdapter.conditions, 'invulnerable')).toBe(false);
    expect(isKnownCondition(Dnd5eAdapter.conditions, '')).toBe(false);
    expect(isKnownCondition(Dnd5eAdapter.conditions, '   ')).toBe(false);
  });

  it('uses the active system vocabulary (PF2e Off-Guard is known; 5e Charmed is not)', () => {
    expect(isKnownCondition(Pf2eAdapter.conditions, 'Off-Guard')).toBe(true);
    expect(isKnownCondition(Pf2eAdapter.conditions, 'off-guard')).toBe(true);
    expect(isKnownCondition(Pf2eAdapter.conditions, 'Charmed')).toBe(false);
    expect(isKnownCondition(Dnd5eAdapter.conditions, 'Off-Guard')).toBe(false);
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
    expect(mapped.abilityRepresentation).toBe('score');
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
    expect(mapped.abilityRepresentation).toBe('score');
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

  it('falls back to 5e for an unrecognized rule-system slug (PF2e is registered under pf2e-srd, not this)', () => {
    expect(ruleSystemAdapter('pathfinder-2e')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('some-homebrew-pack')).toBe(Dnd5eAdapter);
  });
});

/**
 * Level cap per rule system (issue #535). The cap was previously hardcoded as 5e's 20 inside
 * `CharactersService.levelUp`; it now lives on each adapter as `maxLevel`. These assert every
 * adapter reports the system-correct ceiling (5e/PF1e/PF2e/Starfinder = 20, 13th Age = 10) and
 * that a system with no hard cap (Open Legend, OSR retroclones) reports Infinity, so the
 * `level >= maxLevel` gate in `levelUp` never trips for them and the character may advance past
 * the 5e ceiling that used to wrongly block them.
 */
describe('RuleSystemAdapter — maxLevel per system (issue #535)', () => {
  it('5e-family systems cap at level 20', () => {
    expect(Dnd5eAdapter.maxLevel).toBe(20);
    expect(Pathfinder1eAdapter.maxLevel).toBe(20);
    expect(Pf2eAdapter.maxLevel).toBe(20);
    expect(StarfinderAdapter.maxLevel).toBe(20);
  });

  it('13th Age caps at level 10 (its epic-tier ceiling, where 5e uses 20)', () => {
    expect(Archmage13aAdapter.maxLevel).toBe(10);
  });

  it('systems with no hard cap report Infinity (Open Legend, OSR retroclones)', () => {
    expect(OpenLegendAdapter.maxLevel).toBe(Infinity);
    expect(OsrAdapter.maxLevel).toBe(Infinity);
    expect(Number.isFinite(OsrAdapter.maxLevel)).toBe(false);
  });

  it('resolves the cap from the campaign rule-pack slug, defaulting to 20 (5e)', () => {
    // A default / unrecognized campaign resolves to the 5e adapter → level 20.
    expect(ruleSystemAdapter('').maxLevel).toBe(20);
    expect(ruleSystemAdapter('open5e-srd').maxLevel).toBe(20);
    // A registered no-cap system resolves to Infinity, NOT 20.
    expect(ruleSystemAdapter(OPEN_LEGEND_ADAPTER_ID).maxLevel).toBe(Infinity);
    expect(ruleSystemAdapter(OPEN_LEGEND_PACK_SLUG).maxLevel).toBe(Infinity);
    expect(ruleSystemAdapter('basic-fantasy').maxLevel).toBe(Infinity); // OSR family
    // A registered 13th-Age campaign resolves to 10 — the cap the old hardcoded 20 would have
    // wrongly let a level-10 character exceed.
    expect(ruleSystemAdapter('archmage-srd').maxLevel).toBe(10);
  });

  it('the levelUp cap check (`existing.level >= maxLevel`) blocks 5e at 20 but lets a no-cap system past 20', () => {
    // This is the exact comparison `CharactersService.levelUp` makes. It is the regression: with
    // the old hardcoded `>= 20`, BOTH of these would have been true (i.e. BOTH blocked). The fix
    // means only the 5e campaign blocks a level-20 → 21 advance; the no-cap system does not.
    const blockedAtFiveE = 20 >= Dnd5eAdapter.maxLevel; // 20 >= 20 → true, correctly blocked
    const blockedAtNoCap = 20 >= OpenLegendAdapter.maxLevel; // 20 >= Infinity → false, allowed
    expect(blockedAtFiveE).toBe(true);
    expect(blockedAtNoCap).toBe(false);
  });
});

/**
 * XP progression per rule system (issue #441). Thresholds and advisory readiness badges
 * live on each adapter so PF2e/OSR campaigns don't inherit 5e PHB guidance.
 */
describe('RuleSystemAdapter — XP progression per system (issue #441)', () => {
  it('5e-family adapters opt into XP thresholds with both methods defined', () => {
    for (const adapter of [Dnd5eAdapter, Pathfinder1eAdapter, Pf2eAdapter, StarfinderAdapter]) {
      expect(adapter.supportsXpProgression).toBe(true);
      expect(typeof adapter.xpForLevel).toBe('function');
      expect(typeof adapter.levelForXp).toBe('function');
    }
  });

  it('milestone-first systems do not model XP thresholds', () => {
    expect(OpenLegendAdapter.supportsXpProgression).not.toBe(true);
    expect(OsrAdapter.supportsXpProgression).not.toBe(true);
    expect(Archmage13aAdapter.supportsXpProgression).not.toBe(true);
  });

  it('5e PHB table: level 5 requires 6,500 XP cumulative', () => {
    expect(Dnd5eAdapter.xpForLevel!(5)).toBe(6_500);
    expect(Dnd5eAdapter.levelForXp!(6_499)).toBe(4);
    expect(Dnd5eAdapter.levelForXp!(6_500)).toBe(5);
  });

  it('PF2e uses 1,000 XP per level (cumulative)', () => {
    expect(Pf2eAdapter.xpForLevel!(3)).toBe(2_000);
    expect(Pf2eAdapter.levelForXp!(2_999)).toBe(3);
    expect(Pf2eAdapter.levelForXp!(3_000)).toBe(4);
  });

  it('PF1e uses the 3.5e/PF1 cumulative table (differs from 5e)', () => {
    expect(Pathfinder1eAdapter.xpForLevel!(5)).toBe(10_000);
    expect(Dnd5eAdapter.xpForLevel!(5)).toBe(6_500);
  });

  it('13th Age does not model XP thresholds (milestone-first)', () => {
    expect(Archmage13aAdapter.maxLevel).toBe(10);
    expect(xpProgressionSupported(Archmage13aAdapter)).toBe(false);
  });

  it('xpProgressionFromThresholds rejects an empty threshold table', () => {
    expect(() => xpProgressionFromThresholds([], 20)).toThrow(/must not be empty/);
  });

  it('xpProgressionFromThresholds rejects non-monotonic thresholds', () => {
    expect(() => xpProgressionFromThresholds([0, 1000, 500, 2000], 4)).toThrow(/strictly increasing/);
  });

  it('xpProgressionFromThresholds rejects threshold tables shorter than maxLevel', () => {
    expect(() => xpProgressionFromThresholds([0, 1000], 5)).toThrow(/must be >= maxLevel/);
  });

  it('xpProgressForCharacter computes advisory progress for 5e', () => {
    const p = xpProgressForCharacter(Dnd5eAdapter, 4, 6_499);
    expect(p.supported).toBe(true);
    expect(p.ready).toBe(false);
    expect(p.pct).toBeCloseTo(99.9, 0);
  });

  it('xpProgressForCharacter returns supported:false for milestone-first adapters', () => {
    const p = xpProgressForCharacter(Archmage13aAdapter, 5, 100_000);
    expect(p.supported).toBe(false);
    expect(p.ready).toBe(false);
    expect(p.pct).toBe(0);
  });
});

describe('RuleSystemAdapter — adapter capabilities for player-visible rules', () => {
  it.each(listRuleSystemAdapters().map((a) => [a.id, a] as const))(
    '%s adapter defines explicit expectations for death saves, grid distance, initiative model, and action economy',
    (id, adapter) => {
      const hasDeathSaves = hasDeathSavesForAdapter(adapter);
      const gridDistance = gridDistanceForAdapter(adapter);
      const initiativeModel = initiativeModelForAdapter(adapter);
      const actionEconomy = actionEconomyForAdapter(adapter);

      if (id === 'dnd5e') {
        expect(hasDeathSaves).toBe(true);
        expect(gridDistance.square).toBe('euclidean');
        expect(initiativeModel.mode).toBe('individual');
        expect(initiativeModel.usesDexModifier).toBe(true);
        expect(actionEconomy.slots.map((s) => s.key)).toEqual(['action', 'bonus', 'reaction', 'movement']);
      } else if (id === 'pf2e' || id === 'sf2e') {
        expect(hasDeathSaves).toBe(false);
        expect(gridDistance.square).toBe('euclidean');
        expect(initiativeModel.mode).toBe('individual');
        expect(actionEconomy.slots.map((s) => s.key)).toEqual(['actions', 'reaction']);
      } else if (
        id === 'osr' ||
        id === 'basic-fantasy' ||
        id === 'osric' ||
        id === 'swords-wizardry' ||
        id === 'labyrinth-lord' ||
        id === 'old-school-essentials' ||
        id === 'ose'
      ) {
        expect(hasDeathSaves).toBe(false);
        expect(gridDistance.square).toBe('euclidean');
        expect(initiativeModel.mode).toBeDefined();
        expect(actionEconomy.slots.map((s) => s.key)).toEqual(['action']);
      } else {
        expect(hasDeathSaves).toBe(false);
        expect(gridDistance.square).toBe('euclidean');
        expect(initiativeModel.mode).toBe('individual');
        expect(actionEconomy.slots.map((s) => s.key)).toEqual(['action']);
      }
    },
  );

  it('hasDeathSavesForAdapter defaults to true when adapter is null or undefined', () => {
    expect(hasDeathSavesForAdapter(null)).toBe(true);
    expect(hasDeathSavesForAdapter(undefined)).toBe(true);
  });
});
