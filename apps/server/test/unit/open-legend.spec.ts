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
  it.each([
    [1, [20]],
    [2, [20, 4]],
    [3, [20, 6]],
    [4, [20, 8]],
    [5, [20, 10]],
    [6, [20, 6, 6]],
    [7, [20, 6, 8]],
    [8, [20, 8, 8]],
    [9, [20, 8, 10]],
    [10, [20, 10, 10]],
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

  it('scores above 10 extend the 2d10 bonus pool by one d10 per extra point', () => {
    expect(openLegendAttributeDicePool(11).dice).toEqual([20, 10, 10, 10]);
    expect(openLegendAttributeDicePool(13).dice).toEqual([20, 10, 10, 10, 10, 10]);
  });

  it('clamps/truncates non-integer and negative scores', () => {
    expect(openLegendAttributeDicePool(-3).disadvantage).toBe(true);
    expect(openLegendAttributeDicePool(4.9).dice).toEqual([20, 8]);
    expect(openLegendAttributeDicePool(NaN).disadvantage).toBe(true);
  });

  it('exposes the table through the optional adapter member (5e leaves it undefined)', () => {
    expect(OpenLegendAdapter.attributeDicePool?.(5).dice).toEqual([20, 10]);
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
    // score 4 -> [20, 8]. d20: 20 (explode) -> 5 = 25; d8: 8 (explode) -> 2 = 10. total 35.
    const roll = rollActionDice(4, scriptedRoller([20, 5, 8, 2]));
    expect(roll.pool).toEqual([20, 8]);
    expect(roll.dice.map((d) => d.total)).toEqual([25, 10]);
    expect(roll.total).toBe(35);
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
    expect(OpenLegendAdapter.initiativeModifier(mapped.abilityScores)).toBe(1);
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
  it('maps sections to Campfire entry types (banes AND boons -> condition)', () => {
    expect(ALL_OPEN_LEGEND_SECTIONS).toEqual(['creatures', 'banes', 'boons', 'feats', 'items']);
    expect(entryTypeForOpenLegendSection('creatures')).toBe('monster');
    expect(entryTypeForOpenLegendSection('banes')).toBe('condition');
    expect(entryTypeForOpenLegendSection('boons')).toBe('condition');
    expect(entryTypeForOpenLegendSection('feats')).toBe('feat');
    expect(entryTypeForOpenLegendSection('items')).toBe('item');
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

  it('maps a paginated creature section: descriptor/level/Guard/attributes into dataJson', async () => {
    const { entries } = await fetchOpenLegendSection(fake.baseUrl, 'creatures', silentLogger);
    expect(entries.map((e) => e.name).sort()).toEqual(['Goblin', 'Ogre']);
    const goblin = entries.find((e) => e.name === 'Goblin')!;
    expect(goblin.type).toBe('monster');
    expect(goblin.slug).toBe('goblin');
    expect(goblin.license).toBe('Open Game License v1.0a');
    const data = JSON.parse(goblin.dataJson!);
    expect(data.descriptor).toBe('Small humanoid');
    expect(data.level).toBe(1);
    expect(data.defenses.guard).toBe(13);
    expect(data.attributes.agility).toBe(3);
    expect(data.banes).toEqual(['Prone']);
  });

  it('maps banes as condition entries tagged kind=bane in dataJson', async () => {
    const { entries } = await fetchOpenLegendSection(fake.baseUrl, 'banes', silentLogger);
    const blinded = entries.find((e) => e.name === 'Blinded')!;
    expect(blinded.type).toBe('condition');
    expect(JSON.parse(blinded.dataJson!)).toMatchObject({ kind: 'bane', power: 3, attribute: 'Any', resist: 'Fortitude' });
  });

  it('maps boons served as a BARE JSON ARRAY (single-file export shape) as condition/kind=boon', async () => {
    const { entries } = await fetchOpenLegendSection(fake.baseUrl, 'boons', silentLogger);
    expect(entries.map((e) => e.name).sort()).toEqual(['Flying', 'Haste']);
    const haste = entries.find((e) => e.name === 'Haste')!;
    expect(haste.type).toBe('condition');
    expect(JSON.parse(haste.dataJson!)).toMatchObject({ kind: 'boon', attribute: 'Movement' });
  });

  it('maps feats and items with their Open Legend fields', async () => {
    const feats = (await fetchOpenLegendSection(fake.baseUrl, 'feats', silentLogger)).entries;
    expect(feats[0]).toMatchObject({ name: 'Combat Momentum', type: 'feat' });
    expect(JSON.parse(feats[0].dataJson!)).toMatchObject({ tier: 'Adept', prerequisite: 'Agility 3' });

    const items = (await fetchOpenLegendSection(fake.baseUrl, 'items', silentLogger)).entries;
    expect(items[0]).toMatchObject({ name: 'Greatsword', type: 'item' });
    expect(JSON.parse(items[0].dataJson!)).toMatchObject({ category: 'Weapon', wealthLevel: 2, properties: ['Two-handed', 'Forceful'] });
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

  it('collapses same-name creatures to one canonical (SRD) row and refuses the cross-origin next link', async () => {
    const { entries, dedupedCount } = await fetchOpenLegendSection(fake.baseUrl, 'creatures', silentLogger);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Goblin');
    expect(entries[0].source).toBe('Open Legend SRD'); // canonical source kept over the community book
    expect(dedupedCount).toBe(1);
    expect(fake.evilWasHit()).toBe(false); // cross-origin pagination link was NOT followed
  });
});
