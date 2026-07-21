import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake Starfinder SRD JSON API for tests, run in-process on an ephemeral port.
 * Serves 1-2 entries per section using REAL Starfinder 1e values (Core Rulebook, via the
 * OGL Starjammer SRD / Archives of Nethys) in the paginated DRF shape the importer targets
 * ({count,next,previous,results:[...]}), so the mapping code path under test is exercised
 * exactly as it would be against a live SRD JSON mirror — without needing network access.
 *
 * The values below are the actual statblock numbers so the EAC/KAC and Stamina/HP wrinkles
 * are proved against genuine data, not invented shapes:
 *   - Space Goblin Zaperator (CR 1/3): EAC 10, KAC 12, HP 6 (no Stamina — plain alien).
 *   - Ksarik (CR 2): EAC 13, KAC 15, HP 25.
 */
export interface FakeStarfinder {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

function page(results: Array<Record<string, unknown>>) {
  return { count: results.length, next: null, previous: null, results };
}

const DOCUMENT = {
  name: 'Starfinder Core Rulebook',
  key: 'crb',
  licenses: [{ name: 'Open Game License v1.0a', key: 'ogl-1.0a' }],
};

const SPELLS = [
  {
    key: 'crb_magic-missile',
    name: 'Magic Missile',
    desc: 'You send darts of force winging toward a creature.',
    level: 1,
    school: 'evocation',
    classes: ['Mystic', 'Technomancer'],
    casting_time: '1 standard action',
    range: 'Medium (100 ft. + 10 ft./level)',
    duration: 'instantaneous',
    document: DOCUMENT,
  },
];

// Real Starfinder aliens with genuine EAC/KAC and HP (no Stamina — plain monsters).
const ALIENS = [
  {
    key: 'crb_space-goblin-zaperator',
    name: 'Space Goblin Zaperator',
    type: 'humanoid',
    size: 'Small',
    cr: '1/3',
    eac: 10,
    kac: 12,
    hit_points: 6,
    speed: { land: 35 },
    ability_scores: { strength: 8, dexterity: 16, constitution: 11 },
    document: DOCUMENT,
  },
  {
    key: 'crb_ksarik',
    name: 'Ksarik',
    type: 'plant',
    size: 'Medium',
    cr: '2',
    eac: 13,
    kac: 15,
    hit_points: 25,
    speed: { land: 30, climb: 20 },
    ability_scores: { strength: 14, dexterity: 18, constitution: 15 },
    document: DOCUMENT,
  },
];

const EQUIPMENT = [
  {
    key: 'crb_laser-pistol-azimuth',
    name: 'Laser Pistol, Azimuth',
    desc: 'A reliable sidearm that fires a coherent beam of light.',
    category: 'Small Arms',
    level: 1,
    cost: 350,
    bulk: 'L',
    damage: '1d4 F',
    damage_type: 'fire',
    range: '30 ft.',
    document: DOCUMENT,
  },
];

const CONDITIONS = [
  {
    key: 'crb_flat-footed',
    name: 'Flat-Footed',
    descriptions: [{ desc: "You take a -2 penalty to AC and can't take reactions.", document: 'crb' }],
    document: DOCUMENT,
  },
  {
    key: 'crb_off-kilter',
    name: 'Off-Kilter',
    descriptions: [{ desc: "You can't take move actions except to stand up, and you're flat-footed.", document: 'crb' }],
    document: DOCUMENT,
  },
];

// Starfinder classes carry a Stamina-per-level + HP-per-level + Key Ability Score.
const CLASSES = [
  {
    key: 'crb_soldier',
    name: 'Soldier',
    desc: '',
    stamina: 7,
    hit_points: 7,
    key_ability: 'Strength or Dexterity',
    features: [
      { name: 'Primary Fighting Style', desc: 'At 1st level, you select a fighting style that reflects your training.' },
    ],
    document: DOCUMENT,
  },
];

const RACES = [
  {
    key: 'crb_android',
    name: 'Android',
    desc: 'Androids are humanoid robots infused with organic components and a soul.',
    hit_points: 4,
    traits: [
      { name: 'Constructed', desc: 'For effects targeting creatures by type, androids count as both humanoid and construct.' },
      { name: 'Upgrade Slot', desc: 'Androids have a single armor upgrade slot in their bodies.' },
    ],
    document: DOCUMENT,
  },
];

const FEATS = [
  {
    key: 'crb_weapon-focus',
    name: 'Weapon Focus',
    desc: 'You gain a +1 bonus to attack rolls with the selected weapon type.',
    prerequisite: 'Proficiency with selected weapon type',
    combat_feat: true,
    benefits: [{ desc: 'Choose one weapon type; you gain a +1 bonus to attacks with it.' }],
    document: DOCUMENT,
  },
];

const STARSHIPS = [
  {
    key: 'crb_pegasus',
    name: 'Pegasus',
    frame: 'Explorer',
    tier: 3,
    speed: 8,
    ac: 15,
    tl: 14,
    shields: 'Basic 40',
    weapons: ['Coilgun', 'Light Laser Cannon'],
    document: DOCUMENT,
  },
];

const VEHICLES = [
  {
    key: 'crb_enercycle',
    name: 'Enercycle',
    desc: 'A single-rider anti-gravity motorcycle.',
    level: 2,
    eac: 10,
    kac: 12,
    hit_points: 30,
    speed: { drive: 50 },
    passengers: 1,
    document: DOCUMENT,
  },
];

function mountSections(app: express.Express) {
  app.get('/v1/spells/', (_req, res) => res.json(page(SPELLS)));
  app.get('/v1/aliens/', (_req, res) => res.json(page(ALIENS)));
  app.get('/v1/equipment/', (_req, res) => res.json(page(EQUIPMENT)));
  app.get('/v1/conditions/', (_req, res) => res.json(page(CONDITIONS)));
  app.get('/v1/classes/', (_req, res) => res.json(page(CLASSES)));
  app.get('/v1/races/', (_req, res) => res.json(page(RACES)));
  app.get('/v1/feats/', (_req, res) => res.json(page(FEATS)));
  app.get('/v1/starships/', (_req, res) => res.json(page(STARSHIPS)));
  app.get('/v1/vehicles/', (_req, res) => res.json(page(VEHICLES)));
}

export async function startFakeStarfinder(): Promise<FakeStarfinder> {
  const app = express();
  mountSections(app);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Starfinder server');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

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
