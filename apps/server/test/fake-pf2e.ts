import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake Archives of Nethys 2e Elasticsearch endpoint for tests, run in-process on
 * an ephemeral port. It serves 1-2 entries per section using the REAL AoN `_search`
 * response shape (`{ hits: { total: { value }, hits: [{ _id, _source }] } }`, filtered by
 * `q=type:<t>`), so the PF2e importer under test exercises the same mapping code path it
 * would against the live index — without depending on network access in CI. This mirrors
 * test/fake-open5e.ts. `_source` rows carry a few well-known OPEN game-content fields
 * (name, level, ac, hp, perception, ability modifiers, saves, traits, license, source)
 * plus deliberately-ignored art so the importer's art-stripping is exercised.
 *
 * ROW SHAPES ARE CAPTURED FROM THE LIVE INDEX, NOT INVENTED. An earlier version of this
 * file used the shape the mappers happened to want — `size: 'Small'`, `price: '1 gp'`,
 * `range: '500 feet'`, `source: 'Player Core'` — where the live index actually serves
 * `size: ['Small']`, `price: 45` + `price_raw: '45 credits'`, `range: 500` +
 * `range_raw: '500 feet'`, `source: ['Player Core']`. Every one of those mismatches was a
 * field the importer dropped in production while this suite stayed green. Keep these rows
 * shaped like the live documents:
 *   - list-wrapped scalars: `size`, `source`, `trait`, `attribute`, `domain`, `language`
 *   - number + `_raw` display-string pairs: `price`, `bulk`, `range`, `duration`, `area`
 *   - creatures publish ability NAMES only (`creature_ability`), never action objects
 *   - `text` retains one `<title …>` header tag that the importer must strip
 */
export interface FakePf2e {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

// Real AoN `_source` rows (mechanical OGC fields only; `image` is present to prove the
// importer drops art). Ability fields are MODIFIERS, as PF2e statblocks list them.
const CREATURES = [
  {
    id: 'goblin-warrior',
    name: 'Goblin Warrior',
    type: 'Creature',
    level: -1,
    ac: 16,
    hp: 6,
    perception: 2,
    strength: 0,
    dexterity: 3,
    constitution: 1,
    intelligence: 0,
    wisdom: -1,
    charisma: 1,
    fortitude_save: 5,
    reflex_save: 7,
    will_save: 3,
    speed: { land: 25, max: 25 },
    size: ['Small'],
    rarity: 'common',
    trait: ['Goblin', 'Humanoid'],
    // Live AoN publishes ability/strike NAMES only — there is no per-action document.
    creature_ability: ['Shortsword', 'Goblin Scuttle'],
    attack_bonus: [6, 6],
    skill_mod: { acrobatics: 5, stealth: 5 },
    language: ['Common', 'Goblin'],
    creature_family: 'Goblin',
    resistance: { fire: 2 },
    summary: 'Goblin warriors form the bulk of most goblin fighting forces.',
    text: 'Goblin warriors form the bulk of most goblin fighting forces.',
    source: ['Pathfinder Monster Core'],
    license: 'ORC',
    image: 'https://example.invalid/goblin.png',
  },
  {
    id: 'dragon-adult-red',
    name: 'Adult Red Dragon',
    type: 'Creature',
    level: 14,
    ac: 37,
    hp: 300,
    perception: 27,
    strength: 9,
    dexterity: 4,
    constitution: 7,
    intelligence: 3,
    wisdom: 5,
    charisma: 6,
    fortitude_save: 27,
    reflex_save: 24,
    will_save: 25,
    speed: { land: 40, fly: 120, max: 120 },
    size: ['Huge'],
    rarity: 'uncommon',
    trait: ['Dragon', 'Fire'],
    immunity: ['fire', 'paralyzed', 'sleep'],
    text: 'The most covetous and cruel of the chromatic dragons.',
    source: ['Pathfinder Monster Core'],
    license: 'ORC',
  },
];

const SPELLS = [
  {
    id: 'fireball',
    name: 'Fireball',
    type: 'Spell',
    level: 3,
    tradition: ['Arcane', 'Primal'],
    // Cast time is indexed under `actions` as a printed label, not under `cast`.
    actions: 'Two Actions',
    actions_number: 2,
    component: ['somatic', 'verbal'],
    range: 500,
    range_raw: '500 feet',
    area: [20],
    area_raw: '20-foot burst',
    duration: 0,
    duration_raw: 'instantaneous',
    saving_throw: 'Reflex',
    school: 'evocation',
    spell_type: 'Spell',
    trait: ['Fire', 'Manipulate'],
    summary: 'A roaring blast of fire detonates at a spot you designate.',
    text: 'A roaring blast of fire detonates at a spot you designate.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const EQUIPMENT = [
  {
    id: 'longsword',
    name: 'Longsword',
    type: 'Item',
    level: 0,
    // Price is the sortable copper value; the printed string lives in `price_raw`.
    price: 100,
    price_raw: '1 gp',
    bulk: 1,
    bulk_raw: '1',
    category: 'weapon',
    item_category: 'Weapons',
    item_subcategory: 'Base Weapons',
    rarity: 'common',
    hands: '1',
    damage: '1d8 S',
    damage_type: ['Slashing'],
    weapon_category: 'Martial',
    weapon_group: 'Sword',
    weapon_type: 'Melee',
    trait: ['Versatile P'],
    // Live `text` keeps AoN's own `<title …>` header tag; the importer must strip it.
    text: '<title level="1" right="Item 0" pfs="Standard"\n>\nThis classic straight-bladed sword has a simple crossbar guard.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
  {
    id: 'chain-mail',
    name: 'Chain Mail',
    type: 'Item',
    level: 0,
    price: 600,
    price_raw: '6 gp',
    bulk: 2,
    bulk_raw: '2',
    category: 'armor',
    item_category: 'Armor',
    rarity: 'common',
    ac: 4,
    dex_cap: 1,
    check_penalty: -2,
    speed_penalty: -5,
    strength: 3,
    armor_category: 'Medium',
    armor_group: 'Chain',
    usage: 'worn armor',
    trait: ['Flexible', 'Noisy'],
    text: 'A suit of interlocking metal rings.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const FEATS = [
  {
    id: 'power-attack',
    name: 'Power Attack',
    type: 'Feat',
    level: 1,
    prerequisite: '',
    actions: 'Two Actions',
    trait: ['Fighter', 'Flourish'],
    summary: 'You unleash a particularly powerful attack that clobbers your foe.',
    text: 'You unleash a particularly powerful attack that clobbers your foe.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const ANCESTRIES = [
  {
    id: 'dwarf',
    name: 'Dwarf',
    type: 'Ancestry',
    hp: 10,
    size: ['Medium'],
    speed: { land: 20, max: 20 },
    attribute: ['Constitution', 'Wisdom'],
    attribute_flaw: ['Charisma'],
    language: ['Common', 'Dwarven'],
    vision: 'Darkvision',
    trait: ['Dwarf', 'Humanoid'],
    summary: 'Dwarves are a short and stocky people who stand proudly.',
    text: 'Dwarves are a short and stocky people who stand proudly.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const CLASSES = [
  {
    id: 'fighter',
    name: 'Fighter',
    type: 'Class',
    hp: 10,
    attribute: ['Strength', 'Dexterity'],
    perception_proficiency: 'Expert',
    fortitude_proficiency: 'Expert',
    reflex_proficiency: 'Expert',
    will_proficiency: 'Trained',
    trait: ['Class'],
    summary: 'You are a master of martial combat, skilled with a variety of weapons.',
    text: 'You are a master of martial combat, skilled with a variety of weapons.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const BACKGROUNDS = [
  {
    id: 'acolyte',
    name: 'Acolyte',
    type: 'Background',
    trait: [],
    attribute: ['Intelligence', 'Wisdom'],
    skill: ['Religion', 'Scribing Lore'],
    feat: ['Student of the Canon'],
    summary: 'You spent your early days in a religious monastery or cloister.',
    text: 'You spent your early days in a religious monastery or cloister.',
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const CONDITIONS = [
  {
    id: 'frightened',
    name: 'Frightened',
    type: 'Condition',
    summary: "You're gripped by fear and struggle to control your nerves.",
    text: "You're gripped by fear and struggle to control your nerves. You take a status penalty equal to this value to all your checks.",
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
  {
    id: 'off-guard',
    name: 'Off-Guard',
    type: 'Condition',
    text: "You're distracted or otherwise unable to focus your full attention on defense, taking a -2 circumstance penalty to AC.",
    source: ['Pathfinder Player Core'],
    license: 'ORC',
  },
];

const VEHICLES = [
  {
    id: 'starfinder-skimmer',
    name: 'Hover Skimmer',
    type: 'Vehicle',
    level: 2,
    price: 40000,
    price_raw: '400 credits',
    ac: 14,
    hp: 40,
    hardness: 8,
    size: ['Large'],
    space: '10 feet long, 5 feet wide, 4 feet high',
    crew: '1 pilot',
    passengers: 1,
    piloting_check: 'Piloting DC 18',
    speed: { land: 200, max: 200 },
    text: 'A fast single-occupant atmospheric skimmer.',
    source: ['Starfinder 2e Playtest Rulebook'],
    license: 'ORC / OGL',
  },
];

const HAZARDS = [
  {
    id: 'burning-floor',
    name: 'Burning Floor',
    type: 'Hazard',
    level: 3,
    ac: 20,
    hp: 32,
    hardness: 6,
    // Hazard stealth is printed prose, not a bare number.
    stealth: 'DC 18 (or 0 if the plates are already sprung)',
    complexity: 'Simple',
    disable: 'Thievery DC 18',
    reset: 'The plates re-arm after 1 minute.',
    trait: ['Fire', 'Mechanical'],
    text: 'Pressure plates ignite the floor.',
    source: ['Pathfinder GM Core'],
    license: 'ORC',
  },
  {
    id: 'story-trap',
    name: 'Story Trap',
    type: 'Hazard',
    level: 4,
    hp: 20,
    text: 'Adventure-specific story content that must not be imported.',
    source: ['Example Adventure Path'],
    license: 'ORC',
  },
  {
    // A genuine *rulebook* whose title merely contains the word "adventure": it must NOT be
    // excluded as an adventure/scenario publication (the source guard is publication-line
    // precise, not a bare "adventure" substring match).
    id: 'rulebook-trap',
    name: 'Rulebook Trap',
    type: 'Hazard',
    level: 2,
    ac: 18,
    hp: 24,
    stealth: 'DC 15',
    complexity: 'Simple',
    text: 'A generic hazard printed in a rules reference.',
    source: ['Pathfinder Book of Adventure'],
    license: 'ORC',
  },
];

const REFERENCES: Record<string, Array<Record<string, unknown>>> = {
  deity: [
    {
      id: 'sarenrae',
      name: 'Sarenrae',
      type: 'Deity',
      edict: 'destroy the undead, redeem the misguided',
      anathema: 'create undead, deny a repentant foe a chance at redemption',
      domain: ['Fire', 'Healing', 'Sun', 'Truth'],
      favored_weapon: ['Scimitar'],
      divine_font: ['Heal'],
      text: 'The Dawnflower.',
      source: ['Pathfinder Lost Omens Gods & Magic'],
      license: 'OGL',
    },
  ],
  ritual: [
    {
      id: 'resurrect',
      name: 'Resurrect',
      type: 'Ritual',
      level: 5,
      cast: '1 day',
      cost: 'diamonds worth the target’s level squared × 20 gp',
      primary_check: 'Religion (master)',
      secondary_check: 'Medicine, Society',
      range: 10,
      range_raw: '10 feet',
      text: 'Return a soul to life.',
      source: ['Pathfinder Player Core'],
      license: 'ORC',
    },
  ],
  plane: [{ id: 'astral-plane', name: 'Astral Plane', type: 'Plane', text: 'A transitive plane.', source: ['Pathfinder GM Core'], license: 'ORC' }],
  curse: [{ id: 'curse-of-nightmares', name: 'Curse of Nightmares', type: 'Curse', level: 2, saving_throw: 'Will', text: 'Restless dreams.', source: ['Pathfinder GM Core'], license: 'ORC' }],
  disease: [{ id: 'filth-fever', name: 'Filth Fever', type: 'Disease', level: 1, onset: 1, onset_raw: '1 day', saving_throw: 'Fortitude', text: 'A debilitating infection.', source: ['Pathfinder GM Core'], license: 'ORC' }],
};

const BY_TYPE: Record<string, Array<Record<string, unknown>>> = {
  creature: CREATURES,
  spell: SPELLS,
  // Live AoN keeps gear under type 'Item' (there is no 'equipment' type) — the
  // importer's equipment section queries `type:item`.
  item: EQUIPMENT,
  feat: FEATS,
  ancestry: ANCESTRIES,
  class: CLASSES,
  background: BACKGROUNDS,
  condition: CONDITIONS,
  vehicle: VEHICLES,
  hazard: HAZARDS,
  ...REFERENCES,
};

/**
 * The importer POSTs `{query: {query_string: {query: 'type:creature'}}}`; extract the type
 * token. Also accepts the legacy `q=type:creature` URL param so the live-smoke raw checks
 * (which probe AoN with a plain GET) can point at this fake too.
 */
function parseType(req: { query: Record<string, unknown>; body?: unknown }): string {
  const body = req.body as { query?: { query_string?: { query?: unknown } } } | undefined;
  const fromBody = body?.query?.query_string?.query;
  const s = typeof fromBody === 'string' ? fromBody : typeof req.query.q === 'string' ? req.query.q : '';
  const m = /type:([a-z]+)/.exec(s);
  return m ? m[1] : '';
}

/**
 * Real AoN pages with `search_after` over a `_doc` sort, so each hit echoes a `sort` cursor
 * and the importer resumes from the last one. Reproduce that contract — a fake that ignored
 * the cursor and always returned page one would loop forever against the real paging code.
 */
function searchAfterOf(req: { body?: unknown }): number {
  const body = req.body as { search_after?: unknown[] } | undefined;
  const cursor = Array.isArray(body?.search_after) ? body?.search_after[0] : undefined;
  return typeof cursor === 'number' ? cursor : -1;
}

function aonPage(rows: Array<Record<string, unknown>>, req: { body?: unknown }, size = 500) {
  const after = searchAfterOf(req);
  const slice = rows.slice(after + 1, after + 1 + size);
  const body = req.body as { pit?: { id?: unknown } } | undefined;
  return {
    // Echoing `pit_id` back mirrors a real PIT search; the importer carries it forward.
    ...(typeof body?.pit?.id === 'string' ? { pit_id: body.pit.id } : {}),
    hits: {
      total: { value: rows.length },
      hits: slice.map((src, i) => ({ _id: src.id, _source: src, sort: [after + 1 + i] })),
    },
  };
}

/**
 * Point-in-time endpoints. The importer opens a PIT per section so a mid-scan index refresh
 * cannot move its cursors, and searches a PIT with NO index in the path — reproduce both
 * here so tests exercise the path production takes rather than only the fallback.
 */
function mountPit(app: express.Express, indices: string[]) {
  for (const index of indices) {
    app.post(`/${index}/_pit`, (_req, res) => res.json({ id: `pit-${index}` }));
  }
  app.delete('/_pit', (_req, res) => res.json({ succeeded: true, num_freed: 1 }));
}

export async function startFakePf2e(): Promise<FakePf2e> {
  const app = express();
  app.use(express.json());

  mountPit(app, ['aon', 'aonsf']);
  app.post(['/aon/_search', '/aonsf/_search', '/_search'], (req, res) => {
    const type = parseType(req);
    res.json(aonPage(BY_TYPE[type] ?? [], req, Number((req.body as { size?: number })?.size ?? 500) || 500));
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF2e server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Fake AoN endpoint reproducing the mixed-row scenario (issue #326): for a `type:background`
 * query the index also returns a stray row whose SOURCE `type` is `feat`. Because the
 * `backgrounds` section maps to entry type `feat`, the stray row's mapped `entry.type`
 * ('feat') equals the section's own entry type — so the old `entry.type !== entryType` guard
 * could never reject it. The corrected guard compares the SOURCE `type` against the section's
 * AoN type (`background`) and must skip the stray. Emits `_source.type === 'feat'`, mapped as
 * a background would be (name/text), so only the source-type guard can tell them apart.
 */
export async function startFakePf2eMixed(): Promise<FakePf2e> {
  const app = express();
  app.use(express.json());
  mountPit(app, ['aon']);
  app.post(['/aon/_search', '/_search'], (req, res) => {
    const type = parseType(req);
    if (type !== 'background') {
      res.json(aonPage([], req));
      return;
    }
    res.json(
      aonPage(
        [
          { id: 'acolyte', name: 'Acolyte', type: 'Background', text: 'A religious upbringing.', source: ['Pathfinder Player Core'], license: 'ORC' },
          // Stray mixed row: source type is `feat`, NOT `background`. Must be skipped.
          { id: 'power-attack', name: 'Power Attack', type: 'Feat', text: 'A stray feat leaked into the background query.', source: ['Pathfinder Player Core'], license: 'ORC' },
        ],
        req,
      ),
    );
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF2e server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Fake AoN endpoint reproducing the de-dupe scenario: the SAME creature name appears in
 * two source books (Monster Core + a Legacy Bestiary). The importer must collapse them to
 * ONE canonical entry per (name, type). Also carries one malformed hit (no `_source`) that
 * must be skipped rather than failing the whole section.
 */
export async function startFakePf2eDuplicates(): Promise<FakePf2e> {
  const app = express();
  app.use(express.json());
  mountPit(app, ['aon']);
  app.post(['/aon/_search', '/_search'], (req, res) => {
    const type = parseType(req);
    if (type !== 'creature') {
      res.json(aonPage([], req));
      return;
    }
    // Hand-built rather than via aonPage(): one hit must be MALFORMED (no `_source`) and
    // still carry a usable sort cursor, which the row-shaped helper cannot express.
    res.json({
      hits: {
        total: { value: 3 },
        hits: [
          { _id: 'goblin-mc', sort: [0], _source: { id: 'goblin-mc', name: 'Goblin Warrior', type: 'Creature', level: -1, hp: 6, source: ['Pathfinder Monster Core'], license: 'ORC' } },
          // Malformed: no _source — must be skipped.
          { _id: 'broken', sort: [1] },
          { _id: 'goblin-legacy', sort: [2], _source: { id: 'goblin-legacy', name: 'Goblin Warrior', type: 'Creature', level: -1, hp: 6, source: ['Legacy Bestiary'], license: 'OGL' } },
        ],
      },
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF2e server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Fake AoN endpoint reproducing the CROSS-SECTION (type, slug) collision (issues #326/#353):
 * a feat named "Cleave" and a background named "Cleave" both map to entry type `feat` with
 * slug `cleave`. Importers only de-dupe WITHIN a section, so both survive to persistPack and
 * collide on the (pack_id, type, slug) UNIQUE index — a fresh install would 500 mid-transaction
 * unless persistPack de-dupes across sections. All other sections are empty.
 */
export async function startFakePf2eCrossSection(): Promise<FakePf2e> {
  const app = express();
  app.use(express.json());
  mountPit(app, ['aon']);
  app.post(['/aon/_search', '/_search'], (req, res) => {
    const type = parseType(req);
    if (type === 'feat') {
      // Same `id` as the background below -> same slug ('cleave'); both map to entry
      // type `feat`, so the two rows share the (type, slug) key across sections.
      res.json(aonPage([{ id: 'cleave', name: 'Cleave', type: 'Feat', level: 1, text: 'A sweeping strike.', source: ['Pathfinder Player Core'], license: 'ORC' }], req));
      return;
    }
    if (type === 'background') {
      res.json(aonPage([{ id: 'cleave', name: 'Cleave', type: 'Background', text: 'You grew up splitting logs.', source: ['Pathfinder Player Core'], license: 'ORC' }], req));
      return;
    }
    res.json(aonPage([], req));
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF2e server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Fake AoN that reproduces a scan LOSING rows: it reports a total of 3 but only ever serves
 * 2. That is what a mid-scan index refresh looks like from the importer's side — the scan
 * ends on a short page having skipped nothing and truncated nothing, which is byte-for-byte
 * the shape `manifestIsComplete` reads as "this fetch is the whole pack" and acts on by
 * DELETING installed entries missing from it. The importer must instead notice the row
 * shortfall and mark the manifest incomplete.
 *
 * `withPit: false` additionally drops the point-in-time endpoints, so this doubles as the
 * fallback-path fixture: the importer must degrade to plain `_doc` paging, not fail.
 */
export async function startFakePf2eLosesRows({ withPit }: { withPit: boolean }): Promise<FakePf2e> {
  const app = express();
  app.use(express.json());
  if (withPit) mountPit(app, ['aon']);
  app.post(['/aon/_search', '/_search'], (req, res) => {
    if (parseType(req) !== 'condition') {
      res.json({ hits: { total: { value: 0 }, hits: [] } });
      return;
    }
    const after = searchAfterOf(req);
    const rows = [
      { id: 'frightened', name: 'Frightened', type: 'Condition', text: 'Gripped by fear.', source: ['Player Core'] },
      { id: 'prone', name: 'Prone', type: 'Condition', text: 'Lying on the ground.', source: ['Player Core'] },
    ];
    const slice = rows.slice(after + 1);
    res.json({
      // Reports THREE rows but only ever serves two — one was paged over.
      hits: { total: { value: 3 }, hits: slice.map((src, i) => ({ _id: src.id, _source: src, sort: [after + 1 + i] })) },
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF2e server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Fake AoN that serves a clean, COMPLETE section but offers no point-in-time endpoint —
 * a mirror, or AoN during a transient error. Nothing is lost here, so the row-count check
 * has nothing to catch; the importer must still refuse to call the manifest complete,
 * because without a snapshot a skip-plus-repeat can net to the right row count while a
 * real row was never seen.
 */
export async function startFakePf2eNoPit(): Promise<FakePf2e> {
  const app = express();
  app.use(express.json());
  // Deliberately no mountPit().
  app.post(['/aon/_search', '/_search'], (req, res) => {
    if (parseType(req) !== 'condition') {
      res.json(aonPage([], req));
      return;
    }
    res.json(
      aonPage(
        [
          { id: 'frightened', name: 'Frightened', type: 'Condition', text: 'Gripped by fear.', source: ['Player Core'] },
          { id: 'prone', name: 'Prone', type: 'Condition', text: 'Lying on the ground.', source: ['Player Core'] },
        ],
        req,
      ),
    );
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF2e server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
