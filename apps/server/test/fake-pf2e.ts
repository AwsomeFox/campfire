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
    speed: { walk: 25 },
    size: 'Small',
    rarity: 'Common',
    trait: ['Goblin', 'Humanoid'],
    text: 'Goblin warriors form the bulk of most goblin fighting forces.',
    source: 'Pathfinder Monster Core',
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
    speed: { walk: 40, fly: 120 },
    size: 'Huge',
    rarity: 'Uncommon',
    trait: ['Dragon', 'Fire'],
    text: 'The most covetous and cruel of the chromatic dragons.',
    source: 'Pathfinder Monster Core',
    license: 'ORC',
  },
];

const SPELLS = [
  {
    id: 'fireball',
    name: 'Fireball',
    type: 'Spell',
    level: 3,
    tradition: ['arcane', 'primal'],
    cast: 2,
    range: '500 feet',
    duration: 'instantaneous',
    trait: ['Fire', 'Manipulate'],
    text: 'A roaring blast of fire detonates at a spot you designate.',
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
];

const EQUIPMENT = [
  {
    id: 'longsword',
    name: 'Longsword',
    type: 'Item',
    level: 0,
    price: '1 gp',
    bulk: 1,
    category: 'Martial Melee Weapon',
    rarity: 'Common',
    trait: ['Versatile P'],
    text: 'This classic straight-bladed sword has a simple crossbar guard.',
    source: 'Pathfinder Player Core',
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
    trait: ['Fighter', 'Flourish'],
    text: 'You unleash a particularly powerful attack that clobbers your foe.',
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
];

const ANCESTRIES = [
  {
    id: 'dwarf',
    name: 'Dwarf',
    type: 'Ancestry',
    hp: 10,
    size: 'Medium',
    speed: { walk: 20 },
    trait: ['Dwarf', 'Humanoid'],
    text: 'Dwarves are a short and stocky people who stand proudly.',
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
];

const CLASSES = [
  {
    id: 'fighter',
    name: 'Fighter',
    type: 'Class',
    hp: 10,
    attribute: ['strength', 'dexterity'],
    trait: ['Class'],
    text: 'You are a master of martial combat, skilled with a variety of weapons.',
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
];

const BACKGROUNDS = [
  {
    id: 'acolyte',
    name: 'Acolyte',
    type: 'Background',
    trait: [],
    text: 'You spent your early days in a religious monastery or cloister.',
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
];

const CONDITIONS = [
  {
    id: 'frightened',
    name: 'Frightened',
    type: 'Condition',
    text: "You're gripped by fear and struggle to control your nerves. You take a status penalty equal to this value to all your checks.",
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
  {
    id: 'off-guard',
    name: 'Off-Guard',
    type: 'Condition',
    text: "You're distracted or otherwise unable to focus your full attention on defense, taking a -2 circumstance penalty to AC.",
    source: 'Pathfinder Player Core',
    license: 'ORC',
  },
];

const VEHICLES = [
  {
    id: 'starfinder-skimmer',
    name: 'Hover Skimmer',
    type: 'Vehicle',
    level: 2,
    ac: 14,
    hp: 40,
    text: 'A fast single-occupant atmospheric skimmer.',
    source: 'Starfinder 2e Playtest Rulebook',
    license: 'ORC / OGL',
  },
];

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
};

function parseType(q: unknown): string {
  // The importer sends `q=type:creature`; extract the type token.
  const s = typeof q === 'string' ? q : '';
  const m = /type:([a-z]+)/.exec(s);
  return m ? m[1] : '';
}

export async function startFakePf2e(): Promise<FakePf2e> {
  const app = express();

  app.get(['/aon/_search', '/aonsf/_search'], (req, res) => {
    const type = parseType(req.query.q);
    const rows = BY_TYPE[type] ?? [];
    const from = Number(req.query.from ?? '0') || 0;
    const size = Number(req.query.size ?? '500') || 500;
    const slice = rows.slice(from, from + size);
    res.json({
      hits: {
        total: { value: rows.length },
        hits: slice.map((src) => ({ _id: src.id, _source: src })),
      },
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
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
  app.get('/aon/_search', (req, res) => {
    const type = parseType(req.query.q);
    if (type !== 'background') {
      res.json({ hits: { total: { value: 0 }, hits: [] } });
      return;
    }
    res.json({
      hits: {
        total: { value: 2 },
        hits: [
          { _id: 'acolyte', _source: { id: 'acolyte', name: 'Acolyte', type: 'Background', text: 'A religious upbringing.', source: 'Pathfinder Player Core', license: 'ORC' } },
          // Stray mixed row: source type is `feat`, NOT `background`. Must be skipped.
          { _id: 'power-attack', _source: { id: 'power-attack', name: 'Power Attack', type: 'Feat', text: 'A stray feat leaked into the background query.', source: 'Pathfinder Player Core', license: 'ORC' } },
        ],
      },
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
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
  app.get('/aon/_search', (req, res) => {
    const type = parseType(req.query.q);
    if (type !== 'creature') {
      res.json({ hits: { total: { value: 0 }, hits: [] } });
      return;
    }
    res.json({
      hits: {
        total: { value: 3 },
        hits: [
          { _id: 'goblin-mc', _source: { id: 'goblin-mc', name: 'Goblin Warrior', type: 'Creature', level: -1, hp: 6, source: 'Pathfinder Monster Core', license: 'ORC' } },
          // Malformed: no _source — must be skipped.
          { _id: 'broken' },
          { _id: 'goblin-legacy', _source: { id: 'goblin-legacy', name: 'Goblin Warrior', type: 'Creature', level: -1, hp: 6, source: 'Legacy Bestiary', license: 'OGL' } },
        ],
      },
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
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
  app.get('/aon/_search', (req, res) => {
    const type = parseType(req.query.q);
    if (type === 'feat') {
      res.json({
        hits: {
          total: { value: 1 },
          // Same `id` as the background below -> same slug ('cleave'); both map to entry
          // type `feat`, so the two rows share the (type, slug) key across sections.
          hits: [{ _id: 'cleave-feat', _source: { id: 'cleave', name: 'Cleave', type: 'Feat', level: 1, text: 'A sweeping strike.', source: 'Pathfinder Player Core', license: 'ORC' } }],
        },
      });
      return;
    }
    if (type === 'background') {
      res.json({
        hits: {
          total: { value: 1 },
          hits: [{ _id: 'cleave-bg', _source: { id: 'cleave', name: 'Cleave', type: 'Background', text: 'You grew up splitting logs.', source: 'Pathfinder Player Core', license: 'ORC' } }],
        },
      });
      return;
    }
    res.json({ hits: { total: { value: 0 }, hits: [] } });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
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
