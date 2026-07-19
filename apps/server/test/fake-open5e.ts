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

export async function startFakeOpen5e(): Promise<FakeOpen5e> {
  const app = express();

  app.get('/v2/spells/', (_req, res) => res.json(page(SPELLS)));
  app.get('/v2/creatures/', (_req, res) => res.json(page(CREATURES)));
  app.get('/v2/magicitems/', (_req, res) => res.json(page(MAGIC_ITEMS)));
  app.get('/v2/conditions/', (_req, res) => res.json(page(CONDITIONS)));

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
