import { fetchPf2eSection, fetchSf2eSection, entryTypeForSection, resolveBaseItemWeaponStats, ALL_PF2E_SECTIONS, PF2E_DEFAULT_LICENSE } from '../../src/modules/rules/pf2e-importer';
import {
  startFakePf2e,
  startFakePf2eDuplicates,
  startFakePf2eLosesRows,
  startFakePf2eMixed,
  startFakePf2eNoPit,
  startFakePf2eStalledPitClose,
  type FakePf2e,
} from '../fake-pf2e';

/**
 * Unit tests for the PF2e importer (issue #295) against the fake AoN Elasticsearch source
 * (test/fake-pf2e.ts) — the same fake-source strategy the Open5e importer uses. They pin
 * the section->rule-entry-type mapping, the PF2e-specific statblock/dataJson shaping, art
 * stripping, license/source stamping, and (name,type) de-duplication.
 */
const silentLogger = { warn: () => {}, info: () => {} };

describe('pf2e-importer — section fetch + mapping', () => {
  let fake: FakePf2e;
  beforeAll(async () => {
    fake = await startFakePf2e();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('maps AoN creatures -> monster with a PF2e statblock in dataJson (level, ac, hp, perception, ability MODS, saves)', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    const goblin = entries.find((e) => e.name === 'Goblin Warrior');
    expect(goblin).toBeDefined();
    expect(goblin!.type).toBe('monster');
    expect(goblin!.slug).toBe('goblin-warrior');
    const data = JSON.parse(goblin!.dataJson!);
    expect(data.level).toBe(-1);
    expect(data.ac).toBe(16);
    expect(data.hp).toBe(6);
    expect(data.perception).toBe(2);
    expect(data.abilityMods).toEqual({ strength: 0, dexterity: 3, constitution: 1, intelligence: 0, wisdom: -1, charisma: 1 });
    expect(data.saves).toEqual({ fortitude: 5, reflex: 7, will: 3 });
    expect(data.traits).toEqual(['Goblin', 'Humanoid']);
    // `size` arrives list-wrapped from the live index; reading it as a bare string dropped
    // it from every imported creature.
    expect(data.size).toBe('Small');
    expect(data.rarity).toBe('Common');
    // AoN publishes ability NAMES only — surface them so the combat card lists them.
    expect(data.specialAbilities).toEqual([
      { name: 'Shortsword', desc: '' },
      { name: 'Goblin Scuttle', desc: '' },
    ]);
    expect(data.skills).toEqual({ acrobatics: 5, stealth: 5 });
    expect(data.languages).toEqual(['Common', 'Goblin']);
    expect(data.resistances).toEqual({ fire: 2 });
    expect(data.creatureFamily).toBe('Goblin');

    // Adult Red Dragon covers a positive double-digit-adjacent mod set (str 9) + perception.
    const dragon = entries.find((e) => e.name === 'Adult Red Dragon');
    expect(dragon).toBeDefined();
    const dragonData = JSON.parse(dragon!.dataJson!);
    expect(dragonData.abilityMods.strength).toBe(9);
    expect(dragonData.abilityMods.dexterity).toBe(4);
    expect(dragonData.perception).toBe(27);
    expect(dragonData.size).toBe('Huge');
    expect(dragonData.immunities).toEqual(['fire', 'paralyzed', 'sleep']);
  });

  it('reads printed mechanics from the `_raw` display strings, not their sortable numeric twins', async () => {
    // AoN indexes price/range/duration/bulk twice: a number for sorting and the printed
    // string under `<field>_raw`. Reading the number as a string yielded '' and silently
    // dropped the field from every row — imported items had no price at all.
    const [equipment, spells] = await Promise.all([
      fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'spells', silentLogger),
    ]);

    const longsword = equipment.entries.find((e) => e.name === 'Longsword')!;
    const item = JSON.parse(longsword.dataJson!);
    expect(item.price).toBe('1 gp');
    expect(item.bulk).toBe('1');
    expect(longsword.summary).toContain('1 gp');

    const fireball = JSON.parse(spells.entries.find((e) => e.name === 'Fireball')!.dataJson!);
    expect(fireball.range).toBe('500 feet');
    expect(fireball.duration).toBe('instantaneous');
    expect(fireball.area).toBe('20-foot burst');
    expect(fireball.cast).toBe('Two Actions');
    expect(fireball.components).toEqual(['somatic', 'verbal']);
    expect(fireball.savingThrow).toBe('Reflex');
  });

  it('carries the full weapon and armor stat blocks into item dataJson', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger);

    const longsword = JSON.parse(entries.find((e) => e.name === 'Longsword')!.dataJson!);
    expect(longsword).toMatchObject({
      damage: '1d8 S',
      damageType: ['Slashing'],
      weaponCategory: 'Martial',
      weaponGroup: 'Sword',
      weaponType: 'Melee',
      hands: '1',
      itemCategory: 'Weapons',
      itemSubcategory: 'Base Weapons',
      traits: ['Versatile P'],
    });

    const chainMail = JSON.parse(entries.find((e) => e.name === 'Chain Mail')!.dataJson!);
    expect(chainMail).toMatchObject({
      ac: 4,
      dexCap: 1,
      checkPenalty: -2,
      speedPenalty: -5,
      strength: 3,
      armorCategory: 'Medium',
      armorGroup: 'Chain',
      usage: 'worn armor',
    });
  });

  /**
   * Issue #2144 — AoN states damage on the BASE weapon only, so a magic weapon arrives with
   * `base_item: ["Longsword"]` and no numbers of its own. Live: 424 of the 651 PF2e rows
   * shelved under Weapons that state no damage do name a base item that does, so without this
   * the majority of the weapons a PF2e character acquires derive no attack when equipped.
   */
  describe('magic weapons inherit their base weapon\'s stats (#2144)', () => {
    it("fills a magic weapon's damage from the base item it names", async () => {
      const { entries } = await fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger);
      const smokingSword = JSON.parse(entries.find((e) => e.name === 'Smoking Sword')!.dataJson!);
      expect(smokingSword).toMatchObject({
        baseItem: 'Longsword',
        damage: '1d8 S',
        damageType: ['Slashing'],
        weaponCategory: 'Martial',
        weaponGroup: 'Sword',
        weaponType: 'Melee',
        // Provenance, not a claim that the magic item printed these itself.
        damageFromBaseItem: 'Longsword',
      });
    });

    it('leaves a weapon that states its own damage untouched', async () => {
      const { entries } = await fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger);
      const longsword = JSON.parse(entries.find((e) => e.name === 'Longsword')!.dataJson!);
      expect(longsword.damage).toBe('1d8 S');
      expect(longsword).not.toHaveProperty('damageFromBaseItem');
    });

    it('fills nothing when the base item is not in the scan', () => {
      // A truncated scan, or a name that matches no row. The entry keeps what it had and the
      // equipped-action derivation falls back to its text-only "fill it in" attack.
      const orphan = { slug: 'x', name: 'Orphan Blade', type: 'item' as const, summary: '', body: '', license: '', source: '', dataJson: JSON.stringify({ itemCategory: 'Weapons', baseItem: 'Nonexistent Sword' }) };
      expect(resolveBaseItemWeaponStats([orphan])).toBe(0);
      expect(JSON.parse(orphan.dataJson)).not.toHaveProperty('damage');
    });

    it('never lets a self-referential base_item add bogus provenance', () => {
      const selfRef = { slug: 'x', name: 'Longsword', type: 'item' as const, summary: '', body: '', license: '', source: '', dataJson: JSON.stringify({ itemCategory: 'Weapons', baseItem: 'Longsword', damage: '1d8 S' }) };
      expect(resolveBaseItemWeaponStats([selfRef])).toBe(0);
      expect(JSON.parse(selfRef.dataJson)).not.toHaveProperty('damageFromBaseItem');
    });
  });

  it('drops absent facts from dataJson instead of storing a wall of nulls', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger);
    const chainMail = JSON.parse(entries.find((e) => e.name === 'Chain Mail')!.dataJson!);
    // Armor carries no weapon stats — those keys must be absent, not present-and-null, so
    // the compendium fact list has nothing empty to render.
    expect(chainMail).not.toHaveProperty('damage');
    expect(chainMail).not.toHaveProperty('reload');
    expect(Object.values(chainMail)).not.toContain(null);
  });

  it("strips AoN's `<title …>` page header from the imported body", async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger);
    const longsword = entries.find((e) => e.name === 'Longsword')!;
    expect(longsword.body).not.toContain('<title');
    expect(longsword.body).toBe('This classic straight-bladed sword has a simple crossbar guard.');
  });

  it('fetches sf2e section using fetchSf2eSection and maps vehicles -> item', async () => {
    const { entries } = await fetchSf2eSection(fake.baseUrl, 'vehicles', silentLogger);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].name).toBe('Hover Skimmer');
    expect(entries[0].type).toBe('item');
    const data = JSON.parse(entries[0].dataJson!);
    expect(data.category).toBe('vehicle');
    expect(data.level).toBe(2);
    expect(data).toMatchObject({
      price: '400 credits',
      ac: 14,
      hp: 40,
      hardness: 8,
      size: 'Large',
      crew: '1 pilot',
      passengers: '1',
      pilotingCheck: 'Piloting DC 18',
    });
    // The old mapper used the flattened statblock text as the summary; a vehicle needs its
    // mechanical line instead.
    expect(entries[0].summary).toBe('Vehicle · Level 2 · 400 credits');
  });

  it('strips art (image fields never make it into dataJson or body)', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    const goblin = entries.find((e) => e.name === 'Goblin Warrior')!;
    expect(goblin.dataJson).not.toContain('image');
    expect(goblin.dataJson).not.toContain('.png');
    expect(goblin.body).not.toContain('.png');
  });

  it('stamps the per-entry open license and source book for attribution', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    const goblin = entries.find((e) => e.name === 'Goblin Warrior')!;
    expect(goblin.license).toBe('ORC');
    expect(goblin.source).toBe('Pathfinder Monster Core');
  });

  it('maps spells (rank/traditions) -> spell', async () => {
    const { entries } = await fetchPf2eSection(fake.baseUrl, 'spells', silentLogger);
    const fireball = entries.find((e) => e.name === 'Fireball')!;
    expect(fireball.type).toBe('spell');
    const data = JSON.parse(fireball.dataJson!);
    expect(data.rank).toBe(3);
    expect(data.traditions).toEqual(['Arcane', 'Primal']);
  });

  it('keeps the mechanics of ancestries, classes, backgrounds, feats and reference entries', async () => {
    const [ancestries, classes, backgrounds, feats, deities, rituals] = await Promise.all([
      fetchPf2eSection(fake.baseUrl, 'ancestries', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'classes', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'backgrounds', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'feats', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'deities', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'rituals', silentLogger),
    ]);

    // Remaster vocabulary: the live index calls these `attribute`/`attribute_flaw`, not
    // `ability_boost`/`ability_flaw` — the names the mapper used to read.
    expect(JSON.parse(ancestries.entries[0].dataJson!)).toMatchObject({
      hp: 10,
      size: 'Medium',
      attributeBoosts: ['Constitution', 'Wisdom'],
      attributeFlaws: ['Charisma'],
      languages: ['Common', 'Dwarven'],
      vision: 'Darkvision',
    });
    expect(JSON.parse(classes.entries[0].dataJson!)).toMatchObject({
      hpPerLevel: 10,
      keyAbility: ['Strength', 'Dexterity'],
      perceptionProficiency: 'Expert',
      willProficiency: 'Trained',
    });
    expect(JSON.parse(backgrounds.entries[0].dataJson!)).toMatchObject({
      kind: 'background',
      attributeBoosts: ['Intelligence', 'Wisdom'],
      skills: ['Religion', 'Scribing Lore'],
      feats: ['Student of the Canon'],
    });
    expect(JSON.parse(feats.entries[0].dataJson!)).toMatchObject({ level: 1, activate: 'Two Actions' });
    expect(JSON.parse(deities.entries[0].dataJson!)).toMatchObject({
      domains: ['Fire', 'Healing', 'Sun', 'Truth'],
      favoredWeapons: ['Scimitar'],
      divineFont: ['Heal'],
      edicts: 'destroy the undead, redeem the misguided',
    });
    expect(JSON.parse(rituals.entries[0].dataJson!)).toMatchObject({
      cast: '1 day',
      primaryCheck: 'Religion (master)',
      secondaryCheck: 'Medicine, Society',
      range: '10 feet',
    });
  });

  it('maps equipment -> item, ancestries -> race, classes -> class, backgrounds -> feat, conditions -> condition', async () => {
    const [equipment, ancestries, classes, backgrounds, conditions] = await Promise.all([
      fetchPf2eSection(fake.baseUrl, 'equipment', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'ancestries', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'classes', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'backgrounds', silentLogger),
      fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger),
    ]);
    expect(equipment.entries[0].type).toBe('item');
    expect(ancestries.entries[0].type).toBe('race');
    expect(classes.entries[0].type).toBe('class');
    expect(backgrounds.entries[0].type).toBe('feat');
    expect(conditions.entries.map((e) => e.name).sort()).toEqual(['Frightened', 'Off-Guard']);
    expect(conditions.entries[0].type).toBe('condition');
  });

  it('maps hazards as first-class budgetable entries and excludes adventure publications', async () => {
    const { entries, skippedCount } = await fetchPf2eSection(fake.baseUrl, 'hazards', silentLogger);
    // "Story Trap" (Example Adventure Path) is excluded; "Rulebook Trap" — whose source
    // merely contains the word "adventure" — is a rulebook and must be retained.
    expect(entries.map((e) => e.name).sort()).toEqual(['Burning Floor', 'Rulebook Trap']);
    expect(entries.some((e) => e.name === 'Story Trap')).toBe(false);
    const burningFloor = entries.find((e) => e.name === 'Burning Floor')!;
    expect(burningFloor.type).toBe('hazard');
    expect(JSON.parse(burningFloor.dataJson!)).toMatchObject({
      level: 3,
      ac: 20,
      hp: 32,
      hardness: 6,
      complexity: 'Simple',
      // Hazard stealth is printed prose, not a number — num() used to null it out.
      stealth: 'DC 18 (or 0 if the plates are already sprung)',
      disable: 'Thievery DC 18',
      reset: 'The plates re-arm after 1 minute.',
    });
    // A rulebook title containing "adventure" is NOT treated as an adventure publication.
    const rulebookTrap = entries.find((e) => e.name === 'Rulebook Trap')!;
    expect(rulebookTrap.source).toBe('Pathfinder Book of Adventure');
    expect(skippedCount).toBe(1); // only the true Adventure Path row is dropped
  });

  it('maps deities, rituals, planes, curses, and diseases into searchable compendium types', async () => {
    const sections = await Promise.all(
      (['deities', 'rituals', 'planes', 'curses', 'diseases'] as const).map((section) =>
        fetchPf2eSection(fake.baseUrl, section, silentLogger),
      ),
    );
    expect(sections.map((result) => result.entries[0].type)).toEqual([
      'other',
      'spell',
      'section',
      'condition',
      'condition',
    ]);
  });

  it('exposes the section -> rule-entry-type mapping and a complete section list', () => {
    expect(entryTypeForSection('creatures')).toBe('monster');
    expect(entryTypeForSection('ancestries')).toBe('race');
    expect(entryTypeForSection('backgrounds')).toBe('feat');
    expect(entryTypeForSection('vehicles')).toBe('item');
    expect(entryTypeForSection('hazards')).toBe('hazard');
    expect(ALL_PF2E_SECTIONS).toHaveLength(15);
  });
});

describe('pf2e-importer — de-duplication + malformed rows', () => {
  let fake: FakePf2e;
  beforeAll(async () => {
    fake = await startFakePf2eDuplicates();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('collapses a same-name creature from two source books to one entry, skips the malformed hit', async () => {
    const { entries, dedupedCount, skippedCount } = await fetchPf2eSection(fake.baseUrl, 'creatures', silentLogger);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Goblin Warrior');
    expect(dedupedCount).toBe(1); // second same-name book collapsed
    expect(skippedCount).toBe(1); // the _source-less hit
  });
});

describe('pf2e-importer — mixed-row source-type guard (issue #326)', () => {
  let fake: FakePf2e;
  beforeAll(async () => {
    fake = await startFakePf2eMixed();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('skips a stray row whose SOURCE type does not match the section AoN type', async () => {
    // The `backgrounds` section maps to entry type `feat`, so a stray `feat` source row
    // would slip past the old `entry.type !== entryType` guard (feat === feat). The
    // corrected guard compares src.type against the AoN type (`background`) and drops it.
    const { entries, skippedCount } = await fetchPf2eSection(fake.baseUrl, 'backgrounds', silentLogger);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Acolyte');
    expect(entries.some((e) => e.name === 'Power Attack')).toBe(false);
    expect(skippedCount).toBe(1); // the stray feat row
  });
});

describe('pf2e-importer — license fallback', () => {
  it('exports a sane OGL/ORC default license', () => {
    expect(PF2E_DEFAULT_LICENSE).toMatch(/OGL|ORC/);
  });
});

/**
 * Paging integrity. These two properties are what stand between a scan that quietly loses
 * rows and `rules.service` DELETING the installed entries missing from that scan (and
 * severing their combatant references) — see `manifestIsComplete`/`completeManifestOptions`.
 */
describe('pf2e-importer — paging integrity', () => {
  it('pages inside a point-in-time snapshot so a mid-scan index refresh cannot move the cursor', async () => {
    const fake = await startFakePf2e();
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: Record<string, unknown> = {};
      try {
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      requests.push({ path: new URL(url).pathname, body });
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const { entries } = await fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger);
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
      await fake.close();
    }

    // Opened a PIT, searched it with no index in the path, sorted on `_shard_doc` (which
    // exists only inside a PIT), asked for an exact total, and released the snapshot.
    expect(requests.some((r) => r.path === '/aon/_pit')).toBe(true);
    const search = requests.find((r) => r.path === '/_search');
    expect(search).toBeDefined();
    expect(search!.body.pit).toMatchObject({ id: 'pit-aon' });
    expect(search!.body.sort).toEqual([{ _shard_doc: 'asc' }]);
    expect(search!.body.track_total_hits).toBe(true);
    expect(requests.some((r) => r.path === '/_pit')).toBe(true);
  });

  it.each([true, false])(
    'refuses to call a row-losing scan complete (point-in-time available: %s)',
    async (withPit) => {
      const fake = await startFakePf2eLosesRows({ withPit });
      try {
        const result = await fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger);
        // Two rows served against a reported total of three. Nothing was malformed and
        // nothing hit a cap, so without the row-count check this fetch would look complete
        // and authorise removing whatever the third row was.
        expect(result.entries).toHaveLength(2);
        expect(result.skippedCount).toBe(0);
        expect(result.truncated).toBe(true);
      } finally {
        await fake.close();
      }
    },
  );

  it('still imports when the endpoint offers no point-in-time snapshot', async () => {
    // A mirror or an older Elasticsearch: degrade to plain `_doc` paging rather than fail.
    const fake = await startFakePf2eLosesRows({ withPit: false });
    try {
      const { entries } = await fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger);
      expect(entries.map((e) => e.name).sort()).toEqual(['Frightened', 'Prone']);
    } finally {
      await fake.close();
    }
  });

  it('never claims completeness for a snapshotless scan, even when every row is accounted for', async () => {
    // The row count alone cannot prove completeness without a snapshot: one refresh can
    // skip a row and repeat another, netting to `rowsSeen === reportedTotal` while a real
    // row was never seen. This fake serves a clean, whole section — nothing skipped,
    // nothing lost — and it must STILL be treated as incomplete, because `manifestIsComplete`
    // turns completeness into permission to delete installed entries.
    const fake = await startFakePf2eNoPit();
    try {
      const result = await fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger);
      expect(result.entries).toHaveLength(2);
      expect(result.skippedCount).toBe(0);
      expect(result.truncated).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('gives up on a stalled snapshot release instead of hanging the install job', async () => {
    // Release is awaited from the section's `finally`; an unbounded request would hang a
    // section whose work was already done. The entries must still come back.
    const fake = await startFakePf2eStalledPitClose();
    try {
      const started = process.hrtime.bigint();
      const { entries } = await fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(entries.map((e) => e.name)).toEqual(['Frightened']);
      // Bounded by the cleanup cap, nowhere near the 30s search timeout.
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      await fake.close();
    }
  }, 30_000);

  it('a complete scan UNDER a snapshot is allowed to claim completeness', async () => {
    // The counterpart to the case above: the whole point of opening a PIT is that a clean
    // scan inside one can be trusted, so pack maintenance still gets to remove stale rows.
    const fake = await startFakePf2e();
    try {
      const result = await fetchPf2eSection(fake.baseUrl, 'conditions', silentLogger);
      expect(result.entries).toHaveLength(2);
      expect(result.skippedCount).toBe(0);
      expect(result.truncated).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
