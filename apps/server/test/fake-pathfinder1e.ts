import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake Pathfinder 1e SRD API for tests, run in-process on an ephemeral port. Serves a
 * small sample per section using REAL PF1e SRD (OGL) values — a real Goblin statblock (CR 1/3,
 * ascending AC 16, Fort/Ref/Will, ability scores), the Fireball spell with per-class levels,
 * PF1e conditions, a full-BAB class, etc. — in the paginated collection shape the importer
 * consumes (`{count, next, previous, results:[...]}`). Mirrors test/fake-open5e.ts so the
 * importer exercises the same mapping code it would against a live structured SRD mirror,
 * without any network access in CI.
 */
export interface FakePathfinder1e {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

function page(results: Array<Record<string, unknown>>) {
  return { count: results.length, next: null, previous: null, results };
}

const OGL_SOURCE = { name: 'PFSRD Core Rulebook', key: 'pfsrd', license: 'OGL v1.0a' };

const SPELLS = [
  {
    key: 'fireball',
    name: 'Fireball',
    school: { name: 'Evocation' },
    levels: { sorcerer: 3, wizard: 3 },
    casting_time: '1 standard action',
    range: 'long (400 ft. + 40 ft./level)',
    duration: 'instantaneous',
    saving_throw: 'Reflex half',
    spell_resistance: 'yes',
    description: 'A burst of flame detonates with a low roar and deals 1d6 points of fire damage per caster level.',
    source: OGL_SOURCE,
  },
  {
    key: 'mage-armor',
    name: 'Mage Armor',
    school: { name: 'Conjuration' },
    levels: { sorcerer: 1, wizard: 1 },
    casting_time: '1 standard action',
    range: 'touch',
    duration: '1 hour/level',
    saving_throw: 'Will negates (harmless)',
    spell_resistance: 'no',
    description: 'An invisible but tangible field of force surrounds the subject, providing a +4 armor bonus to AC.',
    source: OGL_SOURCE,
  },
];

const MONSTERS = [
  {
    key: 'goblin',
    name: 'Goblin',
    type: { name: 'humanoid' },
    size: { name: 'Small' },
    cr: '1/3',
    ac: 16, // ascending AC
    hp: 6,
    init: 6,
    speed: '30 ft.',
    saves: { fort: 3, ref: 3, will: -1 },
    ability_scores: { str: 11, dex: 15, con: 12, int: 10, wis: 9, cha: 6 },
    source: OGL_SOURCE,
  },
  {
    key: 'owlbear',
    name: 'Owlbear',
    type: { name: 'magical beast' },
    size: { name: 'Large' },
    cr: 4,
    ac: 15,
    hp: 47,
    init: 1,
    speed: '30 ft.',
    saves: { fort: 8, ref: 5, will: 2 },
    ability_scores: { str: 21, dex: 12, con: 17, int: 2, wis: 12, cha: 10 },
    source: OGL_SOURCE,
  },
];

const ITEMS = [
  {
    key: 'bag-of-holding-i',
    name: 'Bag of Holding (Type I)',
    category: { name: 'Wondrous Item' },
    aura: 'moderate conjuration',
    caster_level: 9,
    price: '2,500 gp',
    slot: 'none',
    description: 'This bag appears to be a common cloth sack, but its interior is an extradimensional space.',
    source: OGL_SOURCE,
  },
];

const CONDITIONS = [
  { key: 'prone', name: 'Prone', description: 'The character is lying on the ground and takes a -4 penalty on melee attack rolls.', source: OGL_SOURCE },
  { key: 'shaken', name: 'Shaken', description: 'A shaken character takes a -2 penalty on attack rolls, saving throws, skill checks, and ability checks.', source: OGL_SOURCE },
  { key: 'entangled', name: 'Entangled', description: 'The character is ensnared. Being entangled impairs movement and imposes a -2 penalty on attack rolls.', source: OGL_SOURCE },
];

const CLASSES = [
  { key: 'fighter', name: 'Fighter', hit_die: 'd10', bab: 'full', good_saves: ['Fort'], description: 'A master of martial combat, skilled with a variety of weapons and armor.', source: OGL_SOURCE },
  { key: 'wizard', name: 'Wizard', hit_die: 'd6', bab: 'half', good_saves: ['Will'], description: 'A scholarly magic-user capable of manipulating the fabric of reality.', source: OGL_SOURCE },
];

const RACES = [
  { key: 'dwarf', name: 'Dwarf', description: 'Dwarves are a stoic but stern race, ensconced in cities carved from the hearts of mountains.', traits: [{ name: 'Darkvision' }, { name: 'Hardy' }], ability_modifiers: { con: 2, wis: 2, cha: -2 }, source: OGL_SOURCE },
];

const FEATS = [
  { key: 'power-attack', name: 'Power Attack', type: 'Combat', prerequisites: 'Str 13, base attack bonus +1', benefit: 'You can choose to take a -1 penalty on melee attack rolls to gain a +2 bonus on melee damage rolls.', source: OGL_SOURCE },
];

export async function startFakePathfinder1e(): Promise<FakePathfinder1e> {
  const app = express();

  // Spells are served across TWO pages to exercise the importer's pagination loop the way a
  // real paginated SRD mirror serves large sections: page 1 returns the first spell plus a
  // same-origin `next` link, page 2 returns the rest with `next: null`. Total imported still
  // equals SPELLS.length, and a test can prove the page-2 entry (Mage Armor) landed.
  app.get('/api/v1/spells/', (req, res) => {
    const pageNum = Number(req.query.page ?? '1') || 1;
    const limit = req.query.limit ?? '';
    if (pageNum <= 1) {
      const next = `http://${req.get('host')}/api/v1/spells/?limit=${limit}&page=2`;
      res.json({ count: SPELLS.length, next, previous: null, results: SPELLS.slice(0, 1) });
      return;
    }
    res.json({ count: SPELLS.length, next: null, previous: null, results: SPELLS.slice(1) });
  });
  app.get('/api/v1/monsters/', (_req, res) => res.json(page(MONSTERS)));
  app.get('/api/v1/items/', (_req, res) => res.json(page(ITEMS)));
  app.get('/api/v1/conditions/', (_req, res) => res.json(page(CONDITIONS)));
  app.get('/api/v1/classes/', (_req, res) => res.json(page(CLASSES)));
  app.get('/api/v1/races/', (_req, res) => res.json(page(RACES)));
  app.get('/api/v1/feats/', (_req, res) => res.json(page(FEATS)));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Pathfinder 1e server');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

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
 * Fake PF1e server reproducing issue #143: the SAME named monster arrives from multiple OGL
 * documents (Core Rulebook + a third-party book), so "Goblin" appears twice. The importer must
 * collapse to ONE canonical row (prefer the PFSRD/Core source), carry that source's license,
 * and not label the third-party content as Core.
 */
const CORE_SOURCE = { name: 'PFSRD Core Rulebook', key: 'pfsrd', license: 'OGL v1.0a' };
const THIRD_PARTY_SOURCE = { name: 'Homebrew Bestiary', key: 'homebrew', license: 'OGL v1.0a' };

const MULTI_SOURCE_MONSTERS = [
  { key: 'homebrew_goblin', name: 'Goblin', type: { name: 'humanoid' }, size: { name: 'Small' }, cr: '1/3', ac: 14, hp: 5, ability_scores: { dex: 15 }, source: THIRD_PARTY_SOURCE },
  { key: 'pfsrd_goblin', name: 'Goblin', type: { name: 'humanoid' }, size: { name: 'Small' }, cr: '1/3', ac: 16, hp: 6, ability_scores: { dex: 15 }, source: CORE_SOURCE },
];

export async function startFakePathfinder1eMultiSource(): Promise<FakePathfinder1e> {
  const app = express();
  app.get('/api/v1/monsters/', (_req, res) => res.json(page(MULTI_SOURCE_MONSTERS)));
  for (const p of ['spells', 'items', 'conditions', 'classes', 'races', 'feats']) {
    app.get(`/api/v1/${p}/`, (_req, res) => res.json(page([])));
  }

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Pathfinder 1e server');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
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

export interface FakePathfinder1eWithBadPagination extends FakePathfinder1e {
  evilBaseUrl: string;
  evilWasHit(): boolean;
}

/**
 * Fake PF1e server whose `/monsters/` page-1 `next` link points at a DIFFERENT origin — the
 * importer must refuse to follow it (SSRF-style guard). The "evil" server, if ever reached,
 * serves an extra monster; its absence from the results proves the cross-origin guard worked.
 * The page-1 results also include a `null` row, which throws inside the mapper — proving the
 * malformed-row skip path (skippedCount) rather than failing the whole section.
 */
export async function startFakePathfinder1eWithBadPagination(): Promise<FakePathfinder1eWithBadPagination> {
  let evilHit = false;

  const evilApp = express();
  evilApp.get('/api/v1/monsters/', (_req, res) => {
    evilHit = true;
    res.json(page([{ key: 'evil', name: 'Should Never Be Imported', source: OGL_SOURCE }]));
  });
  const evilServer: Server = await new Promise((resolve) => {
    const s = evilApp.listen(0, () => resolve(s));
  });
  const evilAddress = evilServer.address();
  if (!evilAddress || typeof evilAddress === 'string') throw new Error('failed to bind evil fake PF1e server');
  const evilBaseUrl = `http://127.0.0.1:${evilAddress.port}/api/v1`;

  const app = express();
  app.get('/api/v1/monsters/', (_req, res) => {
    res.json({
      count: 2,
      next: `${evilBaseUrl}/monsters/?limit=100&page=2`, // cross-origin — must NOT be followed
      previous: null,
      results: [
        { key: 'goblin', name: 'Goblin', type: { name: 'humanoid' }, size: { name: 'Small' }, cr: '1/3', ac: 16, hp: 6, source: OGL_SOURCE },
        null, // malformed row — throws in the mapper, must be skipped not fatal
      ],
    });
  });
  for (const p of ['spells', 'items', 'conditions', 'classes', 'races', 'feats']) {
    app.get(`/api/v1/${p}/`, (_req, res) => res.json(page([])));
  }

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake PF1e server');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

  return {
    baseUrl,
    evilBaseUrl,
    server,
    evilWasHit: () => evilHit,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        evilServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
