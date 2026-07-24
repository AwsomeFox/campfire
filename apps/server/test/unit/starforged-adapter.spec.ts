import {
  StarforgedAdapter,
  STARFORGED_ADAPTER_ID,
  STARFORGED_PACK_SLUG,
  STARFORGED_IMPACTS,
  STARFORGED_STATBLOCK_PRESENTATION,
  ruleSystemAdapter,
  statblockPresentation,
  DND5E_STATBLOCK_PRESENTATION,
  Dnd5eAdapter,
  CONDITIONS,
} from '@campfire/schema';

/**
 * Unit tests for the Ironsworn: Starforged adapter (issue #405). Starforged is imported as a
 * selectable rule pack under the slug `ironsworn-starforged`, but before this it had no
 * registered adapter — so `ruleSystemAdapter()` fell back to `Dnd5eAdapter`, silently
 * applying 5e combat mechanics (d20 initiative, Armor Class, a 20-level cap) to a PbtA /
 * narrative pack. These assert the slug now resolves to the neutral Starforged adapter and
 * that its presentation and mechanics are NOT 5e.
 */
describe('StarforgedAdapter — registry resolution (issue #405)', () => {
  it('resolves the Starforged adapter for the datasworn pack slug — NOT the 5e fallback', () => {
    expect(STARFORGED_PACK_SLUG).toBe('ironsworn-starforged');
    expect(ruleSystemAdapter('ironsworn-starforged')).toBe(StarforgedAdapter);
    expect(ruleSystemAdapter(STARFORGED_PACK_SLUG)).toBe(StarforgedAdapter);
    // The whole point of the fix: it must no longer inherit the 5e adapter.
    expect(ruleSystemAdapter('ironsworn-starforged')).not.toBe(Dnd5eAdapter);
  });

  it('has the stable Starforged family id', () => {
    expect(StarforgedAdapter.id).toBe(STARFORGED_ADAPTER_ID);
    expect(STARFORGED_ADAPTER_ID).toBe('starforged');
  });
});

describe('StarforgedAdapter — statblock presentation stays NEUTRAL', () => {
  it('returns neutral Rating / Defense labels (never the 5e Challenge / Armor Class copy)', () => {
    const p = statblockPresentation('ironsworn-starforged');
    expect(p).toBe(STARFORGED_STATBLOCK_PRESENTATION);
    expect(p).not.toBe(DND5E_STATBLOCK_PRESENTATION);
    // Neutral wording, by content — not the 5e jargon the fallback would have produced.
    expect(p.rating.full).toBe('Rating');
    expect(p.defense.full).toBe('Defense');
    expect(p.rating.full).not.toBe('Challenge');
    expect(p.defense.full).not.toBe('Armor Class');
  });
});

describe('StarforgedAdapter — narrative (non-5e) mechanics', () => {
  it('has no d20 initiative (uses the d6 action die instead)', () => {
    expect(StarforgedAdapter.initiativeDie).toBe(6);
    expect(StarforgedAdapter.initiativeDie).not.toBe(Dnd5eAdapter.initiativeDie); // not 20
  });

  it('always returns a flat 0 initiative modifier (no governing attribute)', () => {
    expect(StarforgedAdapter.initiativeModifier({ DEX: 18 })).toBe(0);
    expect(StarforgedAdapter.initiativeModifier({ dexterity: 20 })).toBe(0);
    expect(StarforgedAdapter.initiativeModifier(null)).toBe(0);
    expect(StarforgedAdapter.initiativeModifier(undefined)).toBe(0);
  });

  it('preserves add order on an initiative tie (no DEX re-sort)', () => {
    expect(
      StarforgedAdapter.initiativeTiebreak({ initMod: 0, sortOrder: 0 }, { initMod: 0, sortOrder: 3 }),
    ).toBeLessThan(0);
    expect(
      StarforgedAdapter.initiativeTiebreak({ initMod: 0, sortOrder: 5 }, { initMod: 0, sortOrder: 1 }),
    ).toBeGreaterThan(0);
  });

  it('has no hard level cap (advancement is via legacy tracks, not levels)', () => {
    expect(StarforgedAdapter.maxLevel).toBe(Infinity);
    expect(Number.isFinite(StarforgedAdapter.maxLevel)).toBe(false);
    // The exact `levelUp` gate never trips for it, unlike the 5e cap.
    expect(20 >= StarforgedAdapter.maxLevel).toBe(false);
    expect(20 >= Dnd5eAdapter.maxLevel).toBe(true);
  });

  it('uses attribute values directly (identity), not the 5e score→modifier curve', () => {
    expect(StarforgedAdapter.abilityModifier(3)).toBe(3);
    expect(StarforgedAdapter.abilityModifier(0)).toBe(0);
    // 5e would map a score of 3 to -4 — prove it is NOT the 5e formula.
    expect(StarforgedAdapter.abilityModifier(3)).not.toBe(Dnd5eAdapter.abilityModifier(3));
    expect(StarforgedAdapter.abilityModifier(NaN)).toBe(0);
  });

  it('offers the Starforged IMPACTS vocabulary, not the 5e condition list', () => {
    expect(StarforgedAdapter.conditions).toBe(STARFORGED_IMPACTS);
    expect(StarforgedAdapter.conditions).toContain('Wounded');
    expect(StarforgedAdapter.conditions).toContain('Shaken');
    expect(StarforgedAdapter.conditions).not.toEqual(CONDITIONS);
    // 5e-only conditions must not be present.
    expect(StarforgedAdapter.conditions).not.toContain('Prone');
    expect(StarforgedAdapter.conditions).not.toContain('Grappled');
  });

  it('does not opt into DDB import or 5e encounter-difficulty math', () => {
    expect(StarforgedAdapter.supportsDdbImport).toBeUndefined();
    expect(StarforgedAdapter.supportsEncounterDifficulty).toBeUndefined();
  });
});

describe('StarforgedAdapter — statblock mapping (narrative NPCs, no 5e numbers)', () => {
  it('maps rank/nature and leaves AC / HP / ability scores undefined', () => {
    const mapped = StarforgedAdapter.mapStatblock({
      rank: 'formidable',
      nature: 'Marauder',
      features: ['Bristling with weapons'],
      tactics: ['Board and plunder'],
    });
    expect(mapped.challengeRating).toBe('formidable'); // rank fills the rating slot
    expect(mapped.creatureType).toBe('Marauder'); // nature is the "type"
    expect(mapped.armorClass).toBeUndefined();
    expect(mapped.hitPoints).toBeUndefined();
    expect(mapped.abilityScores).toBeUndefined();
    expect(mapped.abilityRepresentation).toBe('native');
    expect(mapped.specialAbilities).toEqual(['Bristling with weapons']);
    expect(mapped.actions).toEqual(['Board and plunder']);
  });

  it('never resolves a monster HP pool (Starforged NPCs have none)', () => {
    expect(StarforgedAdapter.monsterHitPoints({ hitPoints: 45 })).toBeNull();
    expect(StarforgedAdapter.monsterHitPoints({})).toBeNull();
  });
});
