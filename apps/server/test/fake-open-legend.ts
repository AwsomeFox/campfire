import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake of the Open Legend `core-rules` repo served over a raw CDN, run in-process on
 * an ephemeral port. Serves the three sections that exist as open data (boons/banes/feats) at
 * the real file paths the importer requests (`<base>/boons/boons.yml`, …), in the real shapes
 * captured from https://github.com/openlegend/core-rules (see the importer header). Exercises
 * BOTH parse branches of the content-agnostic fetch layer:
 *   - boons → REAL YAML text (with the `!` non-specific tag and list-valued power/attribute)
 *   - banes → a bare JSON array (a single-file JSON export)
 *   - feats → a JSON `{results:[…]}` page (a paginated JSON override shape)
 * so a test proves the importer parses YAML, bare-JSON, and paged-JSON identically — without
 * network access in CI.
 */
export interface FakeOpenLegend {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

// Real-shaped boons, emitted as YAML (mirrors boons/boons.yml, including the leading `!` tag).
const BOONS_YAML = `- !
  name: Haste
  tags:
  - Extraordinary
  power:
  - 5
  attribute:
  - Movement
  invocationTime: 1 Major Action
  duration: Concentration
  description: |
    You infuse the target with preternatural speed.
  effect: |
    The target may take an additional move action each turn.
- !
  name: Flying
  tags:
  - Extraordinary
  power:
  - 5
  attribute:
  - Movement
  invocationTime: 1 Major Action
  duration: Concentration
  description: |
    The target takes to the air.
  effect: |
    The target gains a fly speed equal to their movement speed.
`;

// Real-shaped banes, emitted as a BARE JSON ARRAY (single-file export). `power`/`attackAttributes`
// are lists exactly as in the source; `license`/`source` omitted so the importer stamps defaults.
const BANES = [
  {
    name: 'Blinded',
    tags: ['Extraordinary', 'Physical'],
    power: [5],
    attackAttributes: ['Agility', 'Energy'],
    invocationTime: '1 Major Action',
    duration: 'Resist ends',
    description: 'You blind your foe.',
    effect: 'The target cannot see as long as the effect persists.',
  },
  {
    name: 'Stunned',
    tags: ['Extraordinary'],
    power: [7],
    attackAttributes: ['Energy', 'Entropy'],
    invocationTime: '1 Major Action',
    duration: '1 round',
    description: 'You overwhelm your foe.',
    effect: 'The target may take no actions and loses their next turn.',
  },
];

// Real-shaped feats, emitted as a paginated JSON page (structured `prerequisites`, list `cost`).
const FEATS = [
  {
    name: 'Combat Momentum',
    tags: ['No Prerequisite'],
    cost: [3],
    prerequisites: { tier1: { Other: ['None'] } },
    description: 'You strike with relentless follow-through.',
    effect: 'When you deal damage, you may inflict a bane on the same target.',
  },
];

function jsonPage(results: Array<Record<string, unknown>>) {
  return { count: results.length, next: null, previous: null, results };
}

export async function startFakeOpenLegend(): Promise<FakeOpenLegend> {
  const app = express();
  app.get('/boons/boons.yml', (_req, res) => res.type('text/yaml').send(BOONS_YAML));
  app.get('/banes/banes.yml', (_req, res) => res.json(BANES)); // bare array on purpose
  app.get('/feats/feats.yml', (_req, res) => res.json(jsonPage(FEATS))); // {results} page on purpose

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open Legend server');
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
 * Fake exercising the importer's hardening against a paginated JSON override: `boons/boons.yml`
 * returns the same-named "Haste" boon twice (de-dup must collapse to one) plus a `next` link
 * pointing at a DIFFERENT origin (an "evil" server the same-origin guard must refuse to follow).
 */
export interface FakeOpenLegendBadPagination extends FakeOpenLegend {
  evilBaseUrl: string;
  evilWasHit(): boolean;
}

export async function startFakeOpenLegendBadPagination(): Promise<FakeOpenLegendBadPagination> {
  let evilHit = false;

  const evilApp = express();
  evilApp.get('/boons/boons.yml', (_req, res) => {
    evilHit = true;
    res.json(jsonPage([{ name: 'Should Never Be Imported', power: [1] }]));
  });
  const evilServer: Server = await new Promise((resolve) => {
    const s = evilApp.listen(0, () => resolve(s));
  });
  const evilAddress = evilServer.address();
  if (!evilAddress || typeof evilAddress === 'string') throw new Error('failed to bind evil fake Open Legend server');
  const evilBaseUrl = `http://127.0.0.1:${evilAddress.port}`;

  const app = express();
  app.get('/boons/boons.yml', (_req, res) => {
    res.json({
      count: 2,
      next: `${evilBaseUrl}/boons/boons.yml?page=2`, // cross-origin — must NOT be followed
      previous: null,
      results: [
        { name: 'Haste', power: [5], attribute: ['Movement'], source: 'Open Legend Core Rules' },
        { name: 'Haste', power: [5], attribute: ['Movement'], source: 'Community Codex' },
      ],
    });
  });
  app.get('/banes/banes.yml', (_req, res) => res.json([]));
  app.get('/feats/feats.yml', (_req, res) => res.json(jsonPage([])));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Open Legend server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

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
