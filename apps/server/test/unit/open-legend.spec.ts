import {
  OpenLegendAdapter,
  OPEN_LEGEND_ADAPTER_ID,
  OPEN_LEGEND_PACK_SLUG,
  OPEN_LEGEND_BANES_BOONS,
  ruleSystemAdapter,
  Dnd5eAdapter,
  openLegendAttributeDicePool,
  rollExplodingDie,
  rollActionDice,
} from '@campfire/schema';
import {
  fetchOpenLegendSection,
  ALL_OPEN_LEGEND_SECTIONS,
  entryTypeForOpenLegendSection,
} from '../../src/modules/rules/open-legend-importer';
import { startFakeOpenLegend, startFakeOpenLegendBadPagination } from '../fake-open-legend';

/**
 * Unit tests for the Open Legend ruleset (issue #299): the RuleSystemAdapter's attribute-based
 * exploding-dice model + statblock mapping, and the SRD importer's mapping/hardening against a
 * real-shaped fake codex server. Open Legend has no classes — attributes drive everything — and
 * an action roll is an exploding attribute dice pool rather than a d20+modifier, so the dice
 * math is the load-bearing piece these tests pin down.
 */

/** Deterministic roller: returns the queued faces in order; asserts it isn't over-drawn. */
function scriptedRoller(faces: number[]): (sides: number) => number {
  let i = 0;
  return () => {
    if (i >= faces.length) throw new Error('scripted roller exhausted');
    return faces[i++];
  };
}

describe('OpenLegendAdapter — attribute action-dice table', () => {
  // Official Open Legend Core Rules / SRD action-dice table (openlegend/core-rules
  // core/SRD.md, "Action Dice"): d20 + the listed bonus dice; no mixed die sizes; score 1
  // adds 1d4 (issue #379 — the old table was shifted one score down and invented mixed pools).
  it.each([
    [1, [20, 4]],
    [2, [20, 6]],
    [3, [20, 8]],
    [4, [20, 10]],
    [5, [20, 6, 6]],
    [6, [20, 8, 8]],
    [7, [20, 10, 10]],
    [8, [20, 8, 8, 8]],
    [9, [20, 10, 10, 10]],
    [10, [20, 8, 8, 8, 8]],
  ])('score %i -> dice %p', (score, dice) => {
    const pool = openLegendAttributeDicePool(score);
    expect(pool.dice).toEqual(dice);
    expect(pool.disadvantage).toBe(false);
  });

  it('score 0 is a lone d20 rolled at disadvantage (twice, keep lower)', () => {
    const pool = openLegendAttributeDicePool(0);
    expect(pool.dice).toEqual([20]);
    expect(pool.disadvantage).toBe(true);
  });

  it('scores above 10 continue the official progression (11 -> 4d10, 12 -> 5d8, 13 -> 5d10)', () => {
    expect(openLegendAttributeDicePool(11).dice).toEqual([20, 10, 10, 10, 10]);
    expect(openLegendAttributeDicePool(12).dice).toEqual([20, 8, 8, 8, 8, 8]);
    expect(openLegendAttributeDicePool(13).dice).toEqual([20, 10, 10, 10, 10, 10]);
  });

  it('clamps/truncates non-integer and negative scores', () => {
    expect(openLegendAttributeDicePool(-3).disadvantage).toBe(true);
    expect(openLegendAttributeDicePool(4.9).dice).toEqual([20, 10]); // truncates to score 4
    expect(openLegendAttributeDicePool(NaN).disadvantage).toBe(true);
  });

  it('exposes the table through the optional adapter member (5e leaves it undefined)', () => {
    expect(OpenLegendAdapter.attributeDicePool?.(5).dice).toEqual([20, 6, 6]);
    expect(Dnd5eAdapter.attributeDicePool).toBeUndefined();
  });
});

describe('OpenLegendAdapter — exploding-dice math', () => {
  it('a non-max face does not explode', () => {
    const die = rollExplodingDie(6, scriptedRoller([4]));
    expect(die.faces).toEqual([4]);
    expect(die.total).toBe(4);
  });

  it('a max face explodes: reroll and add, repeatedly, until a non-max face', () => {
    // d6: 6 (explode) -> 6 (explode) -> 3 (stop) = 15
    const die = rollExplodingDie(6, scriptedRoller([6, 6, 3]));
    expect(die.faces).toEqual([6, 6, 3]);
    expect(die.total).toBe(15);
  });

  it('caps the explosion chain so a stuck max roller cannot loop forever', () => {
    const die = rollExplodingDie(4, () => 4, 5); // always max
    expect(die.faces).toHaveLength(5);
    expect(die.total).toBe(20);
  });

  it('rolls a full pool and sums every die, each exploding independently', () => {
    // score 4 -> [20, 10]. d20: 20 (explode) -> 5 = 25; d10: 10 (explode) -> 2 = 12. total 37.
    const roll = rollActionDice(4, scriptedRoller([20, 5, 10, 2]));
    expect(roll.pool).toEqual([20, 10]);
    expect(roll.dice.map((d) => d.total)).toEqual([25, 12]);
    expect(roll.total).toBe(37);
    expect(roll.disadvantage).toBe(false);
  });

  it('score 0 rolls the pool twice and keeps the LOWER total (disadvantage)', () => {
    // first pool d20 -> 15 ; second pool d20 -> 8. keep 8, discard 15.
    const roll = rollActionDice(0, scriptedRoller([15, 8]));
    expect(roll.disadvantage).toBe(true);
    expect(roll.total).toBe(8);
    expect(roll.dice.map((d) => d.total)).toEqual([8]);
    expect(roll.discarded?.map((d) => d.total)).toEqual([15]);
  });

  it('disadvantage still explodes within each of the two rolls', () => {
    // pool A: d20 20->4 = 24 ; pool B: d20 20->20->1 = 41. keep A (24).
    const roll = rollActionDice(0, scriptedRoller([20, 4, 20, 20, 1]));
    expect(roll.total).toBe(24);
    expect(roll.discarded?.[0].total).toBe(41);
  });
});

describe('OpenLegendAdapter — initiative + ability modifier', () => {
  it('ability modifier is the attribute value itself (no 5e floor((score-10)/2) offset)', () => {
    expect(OpenLegendAdapter.abilityModifier(0)).toBe(0);
    expect(OpenLegendAdapter.abilityModifier(5)).toBe(5);
    expect(OpenLegendAdapter.abilityModifier(9)).toBe(9);
  });

  it('initiative is an Agility roll: modifier reads Agility, die stays the anchoring d20', () => {
    expect(OpenLegendAdapter.initiativeDie).toBe(20);
    expect(OpenLegendAdapter.initiativeModifier({ AGILITY: 4 })).toBe(4); // normalized (uppercased) char stats
    expect(OpenLegendAdapter.initiativeModifier({ agility: 3 })).toBe(3); // raw statblock attributes
    expect(OpenLegendAdapter.initiativeModifier({ MIGHT: 5 })).toBe(0); // no agility -> 0
    expect(OpenLegendAdapter.initiativeModifier(null)).toBe(0);
    expect(OpenLegendAdapter.initiativeModifier(undefined)).toBe(0);
  });
});

describe('OpenLegendAdapter — banes/boons condition vocabulary', () => {
  it('offers the Open Legend banes+boons list as the condition vocabulary', () => {
    expect(OpenLegendAdapter.conditions).toBe(OPEN_LEGEND_BANES_BOONS);
    expect(OpenLegendAdapter.conditions).toContain('Blinded'); // bane
    expect(OpenLegendAdapter.conditions).toContain('Haste'); // boon
  });

  // Issue #379/#385: the quick-apply chip list must be the REAL compendium names (27 banes +
  // 32 boons from openlegend/core-rules banes.yml / boons.yml), so chip↔imported-entry lookup
  // hits. The old list invented ~10 names (Dazed, Nauseated, Prone, Unconscious, Flying,
  // Invisibility, Enhance Attribute, Sanctuary, Shielded, Mind Reading) and dropped real ones.
  it('matches the real imported compendium names (no invented chips, none of the real ones missing)', () => {
    expect(OPEN_LEGEND_BANES_BOONS).toHaveLength(27 + 32);

    // Real names that must be present (and were wrong/missing before).
    for (const real of ['Flight', 'Invisible', 'Bolster', 'Demoralized', 'Persistent Damage', 'Death', 'Truesight']) {
      expect(OPEN_LEGEND_BANES_BOONS).toContain(real);
    }
    // Invented names that must NOT appear (they aren't real banes/boons).
    for (const fake of ['Dazed', 'Nauseated', 'Prone', 'Unconscious', 'Flying', 'Invisibility', 'Enhance Attribute', 'Sanctuary', 'Shielded', 'Mind Reading']) {
      expect(OPEN_LEGEND_BANES_BOONS).not.toContain(fake);
    }
    // No duplicates.
    expect(new Set(OPEN_LEGEND_BANES_BOONS).size).toBe(OPEN_LEGEND_BANES_BOONS.length);
  });
});

describe('OpenLegendAdapter — statblock mapping', () => {
  it('maps an attribute-based statblock: Guard->AC, level->CR, attributes->abilityScores, hp', () => {
    const mapped = OpenLegendAdapter.mapStatblock({
      descriptor: 'Small humanoid',
      level: 1,
      hp: 10,
      speed: 30,
      defenses: { guard: 13, toughness: 12, resolve: 11 },
      attributes: { agility: 3, might: 0 },
    });
    expect(mapped.creatureType).toBe('Small humanoid');
    expect(mapped.challengeRating).toBe(1);
    expect(mapped.armorClass).toBe(13); // Guard is the AC analogue
    expect(mapped.hitPoints).toBe(10);
    expect(mapped.abilityRepresentation).toBe('native');
    expect(mapped.abilityScores).toEqual({ agility: 3, might: 0 });
  });

  it('resolves monster max HP (rounded), or null when absent/non-positive', () => {
    expect(OpenLegendAdapter.monsterHitPoints({ hp: 45 })).toBe(45);
    expect(OpenLegendAdapter.monsterHitPoints({ hitPoints: 10.6 })).toBe(11);
    expect(OpenLegendAdapter.monsterHitPoints({ hp: 0 })).toBeNull();
    expect(OpenLegendAdapter.monsterHitPoints({})).toBeNull();
  });

  it('initiative derives from the mapped agility attribute (encounters wiring path)', () => {
    const mapped = OpenLegendAdapter.mapStatblock({ level: 4, hp: 45, attributes: { agility: 1, might: 5 } });
    expect(OpenLegendAdapter.initiativeModifier(mapped.abilityScores, mapped.abilityRepresentation)).toBe(1);
  });
});

describe('OpenLegendAdapter — registry resolution', () => {
  it('resolves the Open Legend adapter by pack slug and by family id', () => {
    expect(ruleSystemAdapter(OPEN_LEGEND_PACK_SLUG)).toBe(OpenLegendAdapter);
    expect(ruleSystemAdapter(OPEN_LEGEND_ADAPTER_ID)).toBe(OpenLegendAdapter);
    expect(OpenLegendAdapter.id).toBe('open-legend');
  });

  it('leaves the 5e default untouched for other/empty rule systems', () => {
    expect(ruleSystemAdapter('open5e-srd')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter('')).toBe(Dnd5eAdapter);
    expect(ruleSystemAdapter(null)).toBe(Dnd5eAdapter);
  });
});

describe('Open Legend importer — section entry types', () => {
  it('imports the three sections that exist as open data (boons/banes -> condition, feats -> feat)', () => {
    expect(ALL_OPEN_LEGEND_SECTIONS).toEqual(['boons', 'banes', 'feats']);
    expect(entryTypeForOpenLegendSection('boons')).toBe('condition');
    expect(entryTypeForOpenLegendSection('banes')).toBe('condition');
    expect(entryTypeForOpenLegendSection('feats')).toBe('feat');
  });
});

describe('Open Legend importer — mapping against a real-shaped fake codex', () => {
  let fake: Awaited<ReturnType<typeof startFakeOpenLegend>>;
  const silentLogger = { warn: () => {}, info: () => {} };

  beforeAll(async () => {
    fake = await startFakeOpenLegend();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('parses REAL YAML boons (with the `!` tag + list power/attribute) as condition/kind=boon', async () => {
    const { entries } = await fetchOpenLegendSection(fake.baseUrl, 'boons', silentLogger);
    expect(entries.map((e) => e.name).sort()).toEqual(['Flying', 'Haste']);
    const haste = entries.find((e) => e.name === 'Haste')!;
    expect(haste.type).toBe('condition');
    expect(haste.slug).toBe('haste');
    expect(haste.license).toBe('Open Legend Community License'); // stamped default (files carry no per-row license)
    expect(haste.body).toContain('additional move action'); // description + effect prose
    expect(JSON.parse(haste.dataJson!)).toMatchObject({ kind: 'boon', power: ['5'], attribute: ['Movement'] });
  });

  it('parses banes served as a BARE JSON ARRAY as condition/kind=bane', async () => {
    const { entries } = await fetchOpenLegendSection(fake.baseUrl, 'banes', silentLogger);
    expect(entries.map((e) => e.name).sort()).toEqual(['Blinded', 'Stunned']);
    const blinded = entries.find((e) => e.name === 'Blinded')!;
    expect(blinded.type).toBe('condition');
    // banes carry `attackAttributes` (not `attribute`) — the mapper reads either.
    expect(JSON.parse(blinded.dataJson!)).toMatchObject({ kind: 'bane', power: ['5'], attribute: ['Agility', 'Energy'] });
  });

  it('parses feats served as a JSON {results} page, preserving cost + structured prerequisites', async () => {
    const feats = (await fetchOpenLegendSection(fake.baseUrl, 'feats', silentLogger)).entries;
    expect(feats[0]).toMatchObject({ name: 'Combat Momentum', type: 'feat' });
    const data = JSON.parse(feats[0].dataJson!);
    expect(data.cost).toEqual(['3']);
    expect(data.prerequisites).toMatchObject({ tier1: { Other: ['None'] } });
  });
});

describe('Open Legend importer — hardening (de-dup + cross-origin pagination guard)', () => {
  let fake: Awaited<ReturnType<typeof startFakeOpenLegendBadPagination>>;
  const silentLogger = { warn: () => {}, info: () => {} };

  beforeAll(async () => {
    fake = await startFakeOpenLegendBadPagination();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('collapses same-name boons to one row and refuses the cross-origin next link', async () => {
    const { entries, dedupedCount } = await fetchOpenLegendSection(fake.baseUrl, 'boons', silentLogger);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Haste');
    expect(entries[0].source).toBe('Open Legend Core Rules'); // first-seen kept (stable)
    expect(dedupedCount).toBe(1);
    expect(fake.evilWasHit()).toBe(false); // cross-origin pagination link was NOT followed
  });
});
