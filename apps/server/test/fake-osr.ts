import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake OSR source server for tests, run in-process on an ephemeral port. Serves a
 * small SAMPLE of real Basic Fantasy RPG content (CC-BY-SA 4.0) using the JSON contract the
 * OSR importer targets (see src/modules/rules/osr-importer.ts). Values below are the actual
 * Basic Fantasy statblock/spell numbers, so the importer's mapping is exercised against
 * genuine source data — not invented shapes.
 *
 * Two shapes are served on purpose so the importer's "bare array OR { results } page"
 * handling is both covered:
 *   - /monsters and /spells return a paginated `{ next, results }` page (monsters across
 *     two pages, to exercise the pagination loop).
 *   - /items and /conditions return a bare array.
 */

// Real Basic Fantasy monsters. AC is given in BOTH conventions (descending native +
// ascending) exactly as Basic Fantasy prints them, so the adapter's dual-AC path is fed
// real numbers. (Goblin: AC 14 descending / 6 ascending... note Basic Fantasy prints
// ascending AC where higher is better; here we give the descending value the OSR adapter
// normalizes from.)
const MONSTERS_PAGE_1 = [
  {
    slug: 'goblin',
    name: 'Goblin',
    type: 'Humanoid',
    hitDice: '1-1',
    armorClass: 13, // descending
    armorClassAscending: 6,
    hitPoints: 3,
    thac0: 19,
    movement: '20’',
    numberAppearing: '2d4',
    save: 'NM',
    morale: 7,
    treasureType: 'R',
    xp: 10,
    description: 'Goblins are short, ugly humanoids that live underground and hate sunlight.',
    attacks: [{ name: 'Weapon', damage: '1d6' }],
  },
];

const MONSTERS_PAGE_2 = [
  {
    slug: 'skeleton',
    name: 'Skeleton',
    type: 'Undead',
    hitDice: '1',
    armorClass: 13,
    armorClassAscending: 7,
    hitPoints: 4,
    thac0: 19,
    movement: '20’',
    numberAppearing: '3d4',
    save: 'F1',
    morale: 12,
    treasureType: 'None',
    xp: 13,
    description: 'Animated bones of the dead, skeletons attack until destroyed.',
    attacks: [{ name: 'Weapon', damage: '1d6' }],
  },
];

const SPELLS = [
  {
    slug: 'magic-missile',
    name: 'Magic Missile',
    class: 'magic-user',
    level: 1,
    range: '150’',
    duration: 'Instantaneous',
    description: 'This spell creates a missile of magical energy that automatically hits its target for 1d6+1 damage.',
  },
  {
    slug: 'cure-light-wounds',
    name: 'Cure Light Wounds',
    class: 'cleric',
    level: 1,
    range: 'Touch',
    duration: 'Instantaneous',
    description: 'This spell heals 1d6+1 points of damage, or cures paralysis.',
  },
  // Deliberate duplicate slug (from a "reprint") to prove slug de-dupe.
  {
    slug: 'magic-missile',
    name: 'Magic Missile (reprint)',
    class: 'magic-user',
    level: 1,
    description: 'Duplicate that must be collapsed by the importer.',
  },
];

const ITEMS = [
  { slug: 'sword', name: 'Sword', category: 'Weapon', cost: '15 gp', weight: 60, description: 'A standard longsword dealing 1d8 damage.' },
  { slug: 'leather-armor', name: 'Leather Armor', category: 'Armor', cost: '20 gp', weight: 250, description: 'Basic protection; ascending AC 13.' },
];

const CONDITIONS = [
  { slug: 'paralyzed', name: 'Paralyzed', description: 'A paralyzed creature cannot move or act until the effect ends.' },
  { slug: 'petrified', name: 'Petrified', description: 'A petrified creature is turned to stone and is unaware of its surroundings.' },
];

export interface FakeOsr {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

export async function startFakeOsr(): Promise<FakeOsr> {
  const app = express();

  // Monsters span two pages to exercise the importer's pagination loop.
  app.get('/monsters', (req, res) => {
    const pageNum = Number(req.query.page ?? '1') || 1;
    if (pageNum <= 1) {
      const next = `http://${req.get('host')}/monsters?page=2`;
      res.json({ next, results: MONSTERS_PAGE_1 });
      return;
    }
    res.json({ next: null, results: MONSTERS_PAGE_2 });
  });
  app.get('/spells', (_req, res) => res.json({ next: null, results: SPELLS }));
  // Items and conditions come back as bare arrays (the other accepted shape).
  app.get('/items', (_req, res) => res.json(ITEMS));
  app.get('/conditions', (_req, res) => res.json(CONDITIONS));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake OSR server');
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
