import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake Open5e v2 API for e2e tests, run in-process on an ephemeral
 * port. Serves 2-3 entries per section using the REAL v2 response shape
 * (verified against the live api.open5e.com during development — see
 * src/modules/rules/open5e-importer.ts's header comment for the field-shape
 * notes), so the importer under test exercises the same mapping code path it
 * would against the real API, without depending on network access in CI.
 */
export interface FakeOpen5e {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

function page(results: Array<Record<string, unknown>>) {
  return { count: results.length, next: null, previous: null, results };
}

const DOCUMENT = {
  name: 'System Reference Document 5.2',
  key: 'srd-2024',
  licenses: [{ name: 'Creative Commons Attribution 4.0', key: 'cc-by-40' }],
};

const SPELLS = [
  { key: 'srd_fireball', name: 'Fireball', desc: 'A bright streak flashes to a point and blossoms into fire.', level: 3, school: { name: 'Evocation', key: 'evocation' }, casting_time: 'action', range_text: '150 feet', duration: 'instantaneous', concentration: false, ritual: false, document: DOCUMENT },
  { key: 'srd_mage-armor', name: 'Mage Armor', desc: 'You touch a willing creature to protect it with a magical force.', level: 1, school: { name: 'Abjuration', key: 'abjuration' }, casting_time: 'action', range_text: 'touch', duration: '8 hours', concentration: false, ritual: false, document: DOCUMENT },
];

const CREATURES = [
  { key: 'srd_goblin', name: 'Goblin', type: { name: 'Humanoid', key: 'humanoid' }, size: { name: 'Small', key: 'small' }, challenge_rating: 0.25, armor_class: 15, hit_points: 7, speed: { walk: 30, unit: 'feet' }, ability_scores: { strength: 8, dexterity: 14 }, document: DOCUMENT },
  { key: 'srd_owlbear', name: 'Owlbear', type: { name: 'Monstrosity', key: 'monstrosity' }, size: { name: 'Large', key: 'large' }, challenge_rating: 3, armor_class: 13, hit_points: 59, speed: { walk: 40, unit: 'feet' }, ability_scores: { strength: 20, dexterity: 12 }, document: DOCUMENT },
];

const MAGIC_ITEMS = [
  { key: 'srd_bag-of-holding', name: 'Bag of Holding', desc: 'This bag has an interior space considerably larger than its outside dimensions.', category: { name: 'Wondrous Item', key: 'wondrous-item' }, rarity: { name: 'Uncommon', key: 'uncommon' }, requires_attunement: false, document: DOCUMENT },
];

const CONDITIONS = [
  { key: 'srd_prone', name: 'Prone', descriptions: [{ desc: 'A prone creature has disadvantage on attack rolls.', document: 'srd-2024' }], document: DOCUMENT },
  { key: 'srd_grappled', name: 'Grappled', descriptions: [{ desc: "A grappled creature's speed becomes 0.", document: 'srd-2024' }], document: DOCUMENT },
];

// v2 classes usually have an EMPTY `desc` — the prose lives in `features[]`; subclasses
// share the list with a non-null `subclass_of` sub-object (see open5e-importer.ts header).
const CLASSES = [
  { key: 'srd_barbarian', name: 'Barbarian', desc: '', hit_dice: 'D12', caster_type: 'NONE', subclass_of: null, saving_throws: [{ name: 'Strength' }, { name: 'Constitution' }], primary_abilities: [], features: [{ key: 'srd_barbarian_rage', name: 'Rage', desc: 'In battle, you fight with primal ferocity.', feature_type: 'CLASS_LEVEL_FEATURE', gained_at: [{ level: 1, detail: null }] }], document: DOCUMENT },
  { key: 'srd_berserker', name: 'Path of the Berserker', desc: '', hit_dice: null, caster_type: 'NONE', subclass_of: { key: 'srd_barbarian', name: 'Barbarian' }, saving_throws: [], primary_abilities: [], features: [{ key: 'srd_berserker_frenzy', name: 'Frenzy', desc: 'You can go into a frenzy when you rage.', feature_type: 'CLASS_LEVEL_FEATURE', gained_at: [{ level: 3, detail: null }] }], document: DOCUMENT },
];

// Served from /v2/species/ — v2 has no /races/ route (mirrors the monsters->creatures quirk).
const SPECIES = [
  { key: 'srd_dwarf', name: 'Dwarf', desc: 'Bold and hardy, dwarves are known as skilled warriors and miners.', is_subspecies: false, subspecies_of: null, traits: [{ name: 'Darkvision', desc: 'You can see in dim light within 60 feet.', type: null, order: null }, { name: 'Dwarven Resilience', desc: 'You have advantage on saving throws against poison.', type: null, order: null }], document: DOCUMENT },
  { key: 'srd_hill-dwarf', name: 'Hill Dwarf', desc: 'As a hill dwarf, you have keen senses and remarkable resilience.', is_subspecies: true, subspecies_of: 'srd_dwarf', traits: [{ name: 'Dwarven Toughness', desc: 'Your hit point maximum increases by 1 per level.', type: null, order: null }], document: DOCUMENT },
];

const FEATS = [
  { key: 'srd_grappler', name: 'Grappler', desc: 'You have developed the skills necessary to hold your own in close-quarters grappling.', prerequisite: 'Strength 13 or higher', has_prerequisite: true, benefits: [{ desc: 'You have advantage on attack rolls against a creature you are grappling.' }, { desc: 'You can use your action to try to pin a creature grappled by you.' }], type: 'GENERAL', document: DOCUMENT },
];

export async function startFakeOpen5e(): Promise<FakeOpen5e> {
  const app = express();

  app.get('/v2/spells/', (_req, res) => res.json(page(SPELLS)));
  app.get('/v2/creatures/', (_req, res) => res.json(page(CREATURES)));
  app.get('/v2/magicitems/', (_req, res) => res.json(page(MAGIC_ITEMS)));
  app.get('/v2/conditions/', (_req, res) => res.json(page(CONDITIONS)));
  app.get('/v2/classes/', (_req, res) => res.json(page(CLASSES)));
  app.get('/v2/species/', (_req, res) => res.json(page(SPECIES)));
  app.get('/v2/feats/', (_req, res) => res.json(page(FEATS)));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open5e server');
  const baseUrl = `http://127.0.0.1:${address.port}/v2`;

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
 * Fake Open5e server that exercises the importer's hardening (punch list item 10):
 *  - `/v2/spells/` page 1 has ONE malformed row (missing `name`/`key` -> mapper still
 *    succeeds since asString() falls back to '' rather than throwing... so instead we
 *    make the row a non-object, which DOES throw inside mapSpell's property access)
 *    plus one well-formed row, and a `next` link pointing at a DIFFERENT origin (a
 *    second, "evil" server bound on its own ephemeral port) — the importer must refuse
 *    to follow it.
 *  - The "evil" second server, if ever reached, serves an extra spell — its absence
 *    from the imported results proves the cross-origin guard actually worked, not just
 *    that pagination happened to stop.
 */
/**
 * Fake Open5e server exercising the importer's retry/timeout hardening (round-2 finding
 * #1): `/v2/spells/` fails with a 503 on its first TWO requests, then succeeds on the
 * third — pinning that fetchOpen5eSection retries (2 retries, 1s/3s backoff) rather than
 * failing the whole import on a single transient 5xx. Other sections succeed immediately
 * so the test isn't slowed down by unrelated retries.
 */
export interface FakeOpen5eFlaky extends FakeOpen5e {
  spellsRequestCount(): number;
}

export async function startFakeOpen5eFlaky(): Promise<FakeOpen5eFlaky> {
  let spellsRequests = 0;

  const app = express();
  app.get('/v2/spells/', (_req, res) => {
    spellsRequests += 1;
    if (spellsRequests <= 2) {
      res.status(503).json({ detail: 'temporarily unavailable' });
      return;
    }
    res.json(page(SPELLS));
  });
  app.get('/v2/creatures/', (_req, res) => res.json(page(CREATURES)));
  app.get('/v2/magicitems/', (_req, res) => res.json(page(MAGIC_ITEMS)));
  app.get('/v2/conditions/', (_req, res) => res.json(page(CONDITIONS)));
  app.get('/v2/classes/', (_req, res) => res.json(page(CLASSES)));
  app.get('/v2/species/', (_req, res) => res.json(page(SPECIES)));
  app.get('/v2/feats/', (_req, res) => res.json(page(FEATS)));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open5e server');
  const baseUrl = `http://127.0.0.1:${address.port}/v2`;

  return {
    baseUrl,
    server,
    spellsRequestCount: () => spellsRequests,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export interface FakeOpen5eWithBadPagination extends FakeOpen5e {
  evilBaseUrl: string;
  evilWasHit(): boolean;
}

export async function startFakeOpen5eWithBadPagination(): Promise<FakeOpen5eWithBadPagination> {
  let evilHit = false;

  const evilApp = express();
  evilApp.get('/v2/spells/', (_req, res) => {
    evilHit = true;
    res.json(page([{ key: 'evil_spell', name: 'Should Never Be Imported', desc: 'x', document: DOCUMENT }]));
  });
  const evilServer: Server = await new Promise((resolve) => {
    const s = evilApp.listen(0, () => resolve(s));
  });
  const evilAddress = evilServer.address();
  if (!evilAddress || typeof evilAddress === 'string') throw new Error('failed to bind evil fake Open5e server');
  const evilBaseUrl = `http://127.0.0.1:${evilAddress.port}/v2`;

  const app = express();
  app.get('/v2/spells/', (_req, res) => {
    res.json({
      count: 3,
      // Cross-origin next link — the importer must NOT follow this.
      next: `${evilBaseUrl}/spells/?limit=100&page=2`,
      previous: null,
      results: [
        { key: 'srd_fireball', name: 'Fireball', desc: 'A bright streak.', level: 3, school: { name: 'Evocation' }, document: DOCUMENT },
        // Malformed: `document.licenses` is a string instead of an array, and — more
        // importantly — the row itself is `null`, which throws inside the mapper
        // (`row.desc` etc. on null) rather than silently mapping to empty strings.
        null,
      ],
    });
  });
  app.get('/v2/creatures/', (_req, res) => res.json(page([])));
  app.get('/v2/magicitems/', (_req, res) => res.json(page([])));
  app.get('/v2/conditions/', (_req, res) => res.json(page([])));
  app.get('/v2/classes/', (_req, res) => res.json(page([])));
  app.get('/v2/species/', (_req, res) => res.json(page([])));
  app.get('/v2/feats/', (_req, res) => res.json(page([])));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open5e server');
  const baseUrl = `http://127.0.0.1:${address.port}/v2`;

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
