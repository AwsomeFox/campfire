import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake Open Legend codex API for tests, run in-process on an ephemeral port. Serves a
 * few entries per section (creatures/banes/boons/feats/items) in the real-shaped JSON the
 * Open Legend importer targets (see src/modules/rules/open-legend-importer.ts's header notes),
 * so the importer under test exercises the same mapping + hardening code path a live install
 * would — without network access in CI.
 *
 * Deliberately mixes the two response shapes the importer must accept:
 *   - creatures / banes / feats / items → paginated `{count,next,previous,results}` objects
 *   - boons → a BARE top-level JSON array (a single-file community export)
 * so a test can prove `readPage` normalises both.
 */
export interface FakeOpenLegend {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

function page(results: Array<Record<string, unknown>>) {
  return { count: results.length, next: null, previous: null, results };
}

const SRD_LICENSE = 'Open Game License v1.0a';
const SRD_SOURCE = 'Open Legend Community Codex';

// A full eighteen-attribute Open Legend statblock (attributes drive everything — no classes).
const CREATURES = [
  {
    slug: 'goblin',
    name: 'Goblin',
    descriptor: 'Small humanoid',
    level: 1,
    hp: 10,
    speed: 30,
    defenses: { guard: 13, toughness: 12, resolve: 11 },
    attributes: {
      agility: 3, fortitude: 1, might: 0,
      learning: 0, logic: 1, perception: 2, will: 1,
      deception: 2, persuasion: 0, presence: 0,
      alteration: 0, creation: 0, energy: 0, entropy: 0, influence: 0, movement: 2, prescience: 0, protection: 0,
    },
    banes: ['Prone'],
    boons: [],
    actions: [{ name: 'Shortbow', attack: 'agility', damage: '1d20 (agility) lethal' }],
    description: 'A small, cunning humanoid that fights in packs.',
    license: SRD_LICENSE,
    source: SRD_SOURCE,
  },
  {
    slug: 'ogre',
    name: 'Ogre',
    descriptor: 'Large giant',
    level: 4,
    hp: 45,
    speed: 40,
    defenses: { guard: 12, toughness: 16, resolve: 10 },
    attributes: {
      agility: 1, fortitude: 5, might: 5,
      learning: 0, logic: 0, perception: 1, will: 1,
      deception: 0, persuasion: 0, presence: 2,
      alteration: 0, creation: 0, energy: 0, entropy: 0, influence: 0, movement: 1, prescience: 0, protection: 0,
    },
    banes: ['Stunned'],
    boons: [],
    actions: [{ name: 'Greatclub', attack: 'might', damage: '1d20+1d10 (might) lethal' }],
    description: 'A hulking brute that smashes anything in reach.',
    license: SRD_LICENSE,
    source: SRD_SOURCE,
  },
];

const BANES = [
  { slug: 'blinded', name: 'Blinded', power: 3, attribute: 'Any', resist: 'Fortitude', duration: 'until end of next turn', description: 'The target cannot see and treats everything as an unseen target.', license: SRD_LICENSE, source: SRD_SOURCE },
  { slug: 'stunned', name: 'Stunned', power: 5, attribute: 'Any', resist: 'Will', duration: '1 round', description: 'The target may take no actions and loses their next turn.', license: SRD_LICENSE, source: SRD_SOURCE },
];

// Served as a BARE ARRAY (single-file export) — exercises readPage's array branch.
const BOONS = [
  { slug: 'haste', name: 'Haste', power: 5, attribute: 'Movement', duration: 'concentration', description: 'The target may take an additional move action each turn.', license: SRD_LICENSE, source: SRD_SOURCE },
  { slug: 'flying', name: 'Flying', power: 5, attribute: 'Movement', duration: 'concentration', description: 'The target gains a fly speed equal to their movement speed.', license: SRD_LICENSE, source: SRD_SOURCE },
];

const FEATS = [
  { slug: 'combat-momentum', name: 'Combat Momentum', tier: 'Adept', prerequisite: 'Agility 3', description: 'When you deal damage, you may inflict a bane on the same target.', license: SRD_LICENSE, source: SRD_SOURCE },
];

const ITEMS = [
  { slug: 'greatsword', name: 'Greatsword', category: 'Weapon', wealthLevel: 2, properties: ['Two-handed', 'Forceful'], description: 'A heavy blade requiring two hands to wield.', license: SRD_LICENSE, source: SRD_SOURCE },
];

export async function startFakeOpenLegend(): Promise<FakeOpenLegend> {
  const app = express();
  app.get('/api/creatures/', (_req, res) => res.json(page(CREATURES)));
  app.get('/api/banes/', (_req, res) => res.json(page(BANES)));
  app.get('/api/boons/', (_req, res) => res.json(BOONS)); // bare array on purpose
  app.get('/api/feats/', (_req, res) => res.json(page(FEATS)));
  app.get('/api/items/', (_req, res) => res.json(page(ITEMS)));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open Legend server');
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

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
 * Fake Open Legend server reproducing the issue #143 de-dup scenario and the cross-origin
 * pagination guard: `/api/creatures/` returns the same-named "Goblin" twice — once from the
 * core SRD, once from a community book — plus a `next` link pointing at a DIFFERENT origin
 * (an "evil" server). The importer must collapse the two Goblins to one canonical (SRD) row
 * and refuse to follow the cross-origin link.
 */
export interface FakeOpenLegendBadPagination extends FakeOpenLegend {
  evilBaseUrl: string;
  evilWasHit(): boolean;
}

export async function startFakeOpenLegendBadPagination(): Promise<FakeOpenLegendBadPagination> {
  let evilHit = false;

  const evilApp = express();
  evilApp.get('/api/creatures/', (_req, res) => {
    evilHit = true;
    res.json(page([{ slug: 'imp', name: 'Should Never Be Imported', descriptor: 'x', level: 1, license: SRD_LICENSE, source: SRD_SOURCE }]));
  });
  const evilServer: Server = await new Promise((resolve) => {
    const s = evilApp.listen(0, () => resolve(s));
  });
  const evilAddress = evilServer.address();
  if (!evilAddress || typeof evilAddress === 'string') throw new Error('failed to bind evil fake Open Legend server');
  const evilBaseUrl = `http://127.0.0.1:${evilAddress.port}/api`;

  const app = express();
  app.get('/api/creatures/', (_req, res) => {
    res.json({
      count: 2,
      next: `${evilBaseUrl}/creatures/?page=2`, // cross-origin — must NOT be followed
      previous: null,
      results: [
        { slug: 'core_goblin', name: 'Goblin', descriptor: 'Small humanoid', level: 1, hp: 10, document: { key: 'srd', name: 'Open Legend SRD' }, source: 'Open Legend SRD' },
        { slug: 'book_goblin', name: 'Goblin', descriptor: 'Small humanoid', level: 1, hp: 10, document: { key: 'community-book', name: 'Community Bestiary' }, source: 'Community Bestiary' },
      ],
    });
  });
  app.get('/api/banes/', (_req, res) => res.json(page([])));
  app.get('/api/boons/', (_req, res) => res.json([]));
  app.get('/api/feats/', (_req, res) => res.json(page([])));
  app.get('/api/items/', (_req, res) => res.json(page([])));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open Legend server');
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

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
