import {
  Archmage13aAdapter,
  ARCHMAGE_ADAPTER_ID,
  ARCHMAGE_CONDITIONS,
  Dnd5eAdapter,
  ruleSystemAdapter,
} from '@campfire/schema';

/**
 * Unit tests for the 13th Age (Archmage Engine) RuleSystemAdapter (issue #298). 13th Age is
 * d20-adjacent and close to 5e, so ability-modifier / initiative-die behaviour matches; the
 * distinctive parts — the escalation die, the 13th Age condition vocabulary, and level-based
 * statblocks with AC/PD/MD — are what these assert.
 */
describe('Archmage13aAdapter — identity & registry', () => {
  it('has the archmage family id and label', () => {
    expect(Archmage13aAdapter.id).toBe('archmage');
    expect(ARCHMAGE_ADAPTER_ID).toBe('archmage');
    expect(Archmage13aAdapter.label).toBe('13th Age');
  });

  it('resolves from the registry by family id and by the installed pack slug', () => {
    expect(ruleSystemAdapter('archmage')).toBe(Archmage13aAdapter);
    expect(ruleSystemAdapter('archmage-srd')).toBe(Archmage13aAdapter);
  });

  it('does not disturb 5e resolution (siblings/default still get the 5e adapter)', () => {
    expect(ruleSystemAdapter('open5e-srd')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(undefined)).toBe(Dnd5eAdapter);
  });
});

describe('Archmage13aAdapter — ability modifier (same curve as 5e)', () => {
  it.each([
    [8, -1],
    [10, 0],
    [12, 1],
    [14, 2],
    [18, 4],
    [20, 5],
  ])('score %i -> modifier %i', (score, mod) => {
    expect(Archmage13aAdapter.abilityModifier(score)).toBe(mod);
    // parity with the 5e adapter's formula
    expect(Archmage13aAdapter.abilityModifier(score)).toBe(Dnd5eAdapter.abilityModifier(score));
  });
});

describe('Archmage13aAdapter — initiative', () => {
  it('rolls initiative on a d20', () => {
    expect(Archmage13aAdapter.initiativeDie).toBe(20);
  });

  it('derives the initiative modifier from the Dexterity score (canonical or raw keys)', () => {
    expect(Archmage13aAdapter.initiativeModifier({ DEX: 14 })).toBe(2);
    expect(Archmage13aAdapter.initiativeModifier({ dexterity: 18 })).toBe(4);
  });

  it('returns 0 when Dexterity is absent or non-numeric', () => {
    expect(Archmage13aAdapter.initiativeModifier({ STR: 16 })).toBe(0);
    expect(Archmage13aAdapter.initiativeModifier(null)).toBe(0);
    expect(Archmage13aAdapter.initiativeModifier(undefined)).toBe(0);
  });

  it('adds the level term separately (init = d20 + Dex mod + level)', () => {
    expect(Archmage13aAdapter.levelInitiativeBonus(5)).toBe(5);
    expect(Archmage13aAdapter.levelInitiativeBonus(0)).toBe(0);
    expect(Archmage13aAdapter.levelInitiativeBonus('7' as unknown as number)).toBe(7);
  });
});

describe('Archmage13aAdapter — escalation die', () => {
  it.each([
    [1, 0], // round 1: not yet set
    [2, 1], // set to 1 at the start of round 2
    [3, 2],
    [7, 6], // caps at +6
    [8, 6],
    [0, 0],
    [-3, 0],
  ])('round %i -> escalation die %i', (round, esc) => {
    expect(Archmage13aAdapter.escalationDieForRound(round)).toBe(esc);
  });

  it('caps at the documented maximum (+6)', () => {
    expect(Archmage13aAdapter.escalationDieMax).toBe(6);
  });

  it('PCs add the escalation die to attacks; monsters/NPCs do not', () => {
    // Round 3 -> escalation die +2.
    expect(Archmage13aAdapter.attackModifier(5, { round: 3, isPlayerCharacter: true })).toBe(7);
    expect(Archmage13aAdapter.attackModifier(5, { round: 3, isPlayerCharacter: false })).toBe(5);
  });

  it('a feared (escalation-prevented) PC does not add the escalation die', () => {
    expect(
      Archmage13aAdapter.attackModifier(5, { round: 3, isPlayerCharacter: true, escalationPrevented: true }),
    ).toBe(5);
  });
});

describe('Archmage13aAdapter — condition vocabulary', () => {
  it('exposes the 13th Age conditions list', () => {
    expect(Archmage13aAdapter.conditions).toBe(ARCHMAGE_CONDITIONS);
    for (const c of ['confused', 'dazed', 'fear', 'hampered', 'stuck', 'stunned', 'vulnerable', 'weakened', 'staggered']) {
      expect(Archmage13aAdapter.conditions).toContain(c);
    }
  });

  it('is a distinct vocabulary from 5e (no "prone"/"grappled", which 13th Age does not use as named conditions)', () => {
    expect(Archmage13aAdapter.conditions).not.toContain('prone');
    expect(Archmage13aAdapter.conditions).not.toContain('grappled');
  });
});

describe('Archmage13aAdapter — statblock mapping', () => {
  it('maps 13th Age keys (level -> CR slot, ac/pd/md/hp, role/type)', () => {
    const mapped = Archmage13aAdapter.mapStatblock({
      size: 'Large',
      level: 4,
      role: 'Troop',
      creatureType: 'Beast',
      ac: 19,
      pd: 19,
      md: 14,
      hp: 130,
      attacks: 'Bite +8 vs. AC',
    });
    expect(mapped.size).toBe('Large');
    expect(mapped.challengeRating).toBe(4); // 13th Age level occupies the CR slot
    expect(mapped.armorClass).toBe(19);
    expect(mapped.hitPoints).toBe(130);
    // The creatureType slot is labeled "Role" for 13th Age (see ARCHMAGE_STATBLOCK_PRESENTATION),
    // so mapStatblock prefers the native `role` over `type`/`creatureType` to keep the rendered
    // value in lockstep with its label (issue #763). Here that means "Troop", not "Beast".
    expect(mapped.creatureType).toBe('Troop');
    expect(mapped.actions).toBe('Bite +8 vs. AC');
  });

  it('resolves monster max HP (rounded), or null when absent/non-positive', () => {
    expect(Archmage13aAdapter.monsterHitPoints({ hp: 45 })).toBe(45);
    expect(Archmage13aAdapter.monsterHitPoints({ hitPoints: 10.6 })).toBe(11);
    expect(Archmage13aAdapter.monsterHitPoints({ hp: 0 })).toBeNull();
    expect(Archmage13aAdapter.monsterHitPoints({})).toBeNull();
    expect(Archmage13aAdapter.monsterHitPoints({ hp: 'lots' })).toBeNull();
  });
});
