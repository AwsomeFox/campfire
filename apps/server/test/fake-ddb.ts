import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake D&D Beyond character-service for tests, run in-process on an ephemeral
 * port. Serves a representative PUBLIC character sheet using the REAL character-service
 * envelope + field shapes (the `{ id, success, message, data }` wrapper; `stats`/
 * `bonusStats`/`overrideStats` as six `{id,value}` rows; `classes[]` with `definition`/
 * `subclassDefinition`; `baseHitPoints` sans Con; `modifiers.*[]` bonus/proficiency rows;
 * equipped-armor inventory), so the importer under test exercises the same mapping and
 * error paths it would against the live API without any network access.
 *
 * Ids exposed by the fake:
 *   PUBLIC_DDB_CHARACTER_ID — a full public sheet (200 success:true), a martial fighter
 *     with equipped weapon + armor + a text-only class feature (issue #1903 attacks coverage)
 *   CASTER_DDB_CHARACTER_ID — a full public sheet (200 success:true), a Wizard with class
 *     spells + a feat-granted spell (issue #1903 spells/spell-slots coverage)
 *   777 — a private sheet: 403 (the character-service's private response)
 *   9999 — 200 with `success:false` (the "public flag off" 200 variant)
 *   any other id — 404
 */

export const PUBLIC_DDB_CHARACTER_ID = 12345678;

/**
 * A hand-built but realistic public sheet: a level-5 multiclass (Fighter 3 / Rogue 2)
 * Hill Dwarf, Soldier background, with a racial +2 Con ASI, Con/Str save proficiencies,
 * Perception proficiency + Stealth expertise, equipped chain mail + shield, an HP override
 * absent (so the Con-mod formula is exercised), and 7 points of damage taken.
 */
export const PUBLIC_DDB_CHARACTER = {
  id: PUBLIC_DDB_CHARACTER_ID,
  name: 'Thornbeard Ironfist',
  // 1 STR 2 DEX 3 CON 4 INT 5 WIS 6 CHA. Con base 14; a racial +2 lives in modifiers below.
  stats: [
    { id: 1, name: null, value: 16 },
    { id: 2, name: null, value: 12 },
    { id: 3, name: null, value: 14 },
    { id: 4, name: null, value: 10 },
    { id: 5, name: null, value: 13 },
    { id: 6, name: null, value: 8 },
  ],
  bonusStats: [
    { id: 1, value: null },
    { id: 2, value: null },
    { id: 3, value: null },
    { id: 4, value: null },
    { id: 5, value: null },
    { id: 6, value: null },
  ],
  overrideStats: [
    { id: 1, value: null },
    { id: 2, value: null },
    { id: 3, value: null },
    { id: 4, value: null },
    { id: 5, value: null },
    { id: 6, value: null },
  ],
  race: { fullName: 'Hill Dwarf', baseName: 'Dwarf', subRaceShortName: 'Hill' },
  classes: [
    { level: 3, definition: { name: 'Fighter' }, subclassDefinition: { name: 'Champion' } },
    { level: 2, definition: { name: 'Rogue' }, subclassDefinition: null },
  ],
  // Con 14 base + 2 racial = 16 (mod +3). Max HP (no override) = base 39 + bonus 0 +
  // Con-mod(+3) * totalLevel(5) = 54; damage 7 -> current 47.
  baseHitPoints: 39,
  bonusHitPoints: null,
  overrideHitPoints: null,
  removedHitPoints: 7,
  temporaryHitPoints: 0,
  currentXp: 6500,
  background: {
    hasCustomBackground: false,
    definition: { name: 'Soldier' },
    customBackground: { name: null },
  },
  // Chain mail (heavy, armorTypeId 3, AC 16, no Dex) + shield (armorTypeId 4, +2) = AC 18.
  // Plus an equipped Longsword (STR mod +3, proficiency +3 at level 5 -> +6 to hit,
  // 1d8+3 slashing) and an unequipped Dagger that must NOT produce an attack row.
  inventory: [
    { equipped: true, definition: { armorClass: 16, armorTypeId: 3, name: 'Chain Mail' } },
    { equipped: true, definition: { armorClass: 2, armorTypeId: 4, name: 'Shield' } },
    { equipped: false, definition: { armorClass: 12, armorTypeId: 1, name: 'Leather Armor (stowed)' } },
    {
      equipped: true,
      definition: { name: 'Longsword', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d8' }, damageType: 'Slashing', properties: [] },
    },
    {
      equipped: false,
      definition: { name: 'Dagger', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d4' }, damageType: 'Piercing', properties: [{ name: 'Finesse' }] },
    },
  ],
  modifiers: {
    race: [{ type: 'bonus', subType: 'constitution-score', value: 2 }],
    class: [
      { type: 'proficiency', subType: 'strength-saving-throws', value: null },
      { type: 'proficiency', subType: 'constitution-saving-throws', value: null },
      { type: 'proficiency', subType: 'perception-skill', value: null },
      { type: 'expertise', subType: 'stealth-skill', value: null },
      // Weapon training (issue #2144). DDB publishes it as a `proficiency` modifier the same
      // way it publishes saves and skills; `light-armor` is here to prove the importer reads
      // only the `*-weapons` ones and does not sweep up every proficiency it sees.
      { type: 'proficiency', subType: 'simple-weapons', value: null },
      { type: 'proficiency', subType: 'martial-weapons', value: null },
      // A SPLIT grant, as some subclasses publish it (#2144 review): it must survive as
      // `martial melee`, the key `categoryKeys` emits for a melee martial weapon.
      { type: 'proficiency', subType: 'martial-ranged-weapons', value: null },
      { type: 'proficiency', subType: 'light-armor', value: null },
      { type: 'proficiency', subType: 'thieves-tools', value: null },
    ],
    background: [],
    item: [],
    feat: [],
    condition: [],
  },
  // A class feature with no attack/save shape -> imports as a text-only action, enumerated
  // in the import summary rather than dropped (issue #1903).
  actions: {
    class: [{ name: 'Second Wind', snippet: 'Regain 1d10+5 hit points as a bonus action.' }],
    race: [],
    background: [],
    item: [],
    feat: [],
  },
  decorations: { avatarUrl: 'https://www.dndbeyond.com/avatars/thornbeard.png' },
  notes: { backstory: 'A dwarf who left the mountain halls to hunt the orcs that razed his clanhold.' },
};

export const CASTER_DDB_CHARACTER_ID = 87654321;

/**
 * A level-5 Wizard (full caster) with a class spell list (one cantrip + two 1st-level
 * spells, one of them unprepared) plus a feat-granted ritual spell, for the attacks/spells
 * import coverage (issue #1903). INT 18 (mod +4); no weapons/armor so AC/HP paths stay
 * exercised by the fighter fixture above.
 */
export const CASTER_DDB_CHARACTER = {
  id: CASTER_DDB_CHARACTER_ID,
  name: 'Elowen Nightshade',
  stats: [
    { id: 1, value: 8 },
    { id: 2, value: 14 },
    { id: 3, value: 12 },
    { id: 4, value: 18 },
    { id: 5, value: 10 },
    { id: 6, value: 10 },
  ],
  bonusStats: [],
  overrideStats: [],
  race: { fullName: 'High Elf', baseName: 'Elf' },
  classes: [{ level: 5, definition: { name: 'Wizard' }, subclassDefinition: { name: 'Evocation' } }],
  baseHitPoints: 22,
  bonusHitPoints: null,
  overrideHitPoints: null,
  removedHitPoints: 0,
  temporaryHitPoints: 0,
  currentXp: 6500,
  background: { hasCustomBackground: false, definition: { name: 'Sage' }, customBackground: { name: null } },
  inventory: [],
  modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
  classSpells: [
    {
      characterClassId: 1,
      spells: [
        { definition: { name: 'Fire Bolt', level: 0, description: 'A mote of fire streaks toward a target.' }, prepared: true },
        { definition: { name: 'Magic Missile', level: 1, description: 'Three darts of force strike unerringly.' }, prepared: true },
        { definition: { name: 'Mage Armor', level: 1, description: 'AC 13 + Dex modifier.' }, prepared: false },
      ],
    },
  ],
  spells: {
    race: [],
    class: [],
    background: [],
    item: [],
    feat: [{ definition: { name: 'Find Familiar', level: 1, description: 'Summon a spirit in animal form.', ritual: true }, prepared: true }],
  },
  decorations: { avatarUrl: null },
  notes: { backstory: '' },
};

export interface FakeDdb {
  baseUrl: string;
  server: Server;
  /**
   * Issue #714: number of GET /character/:id requests the fake has served since the last
   * `resetHitCount()`. The system-gate tests assert this stays 0 — the gate must reject an
   * incompatible campaign BEFORE any DDB fetch — so a leak shows up as a hard test failure
   * rather than a silent pass.
   */
  hitCount: number;
  resetHitCount(): void;
  close(): Promise<void>;
}

export async function startFakeDdb(): Promise<FakeDdb> {
  const app = express();
  // Mutable counter captured by the request handler below and exposed on the returned handle.
  let hitCount = 0;

  app.get('/character/:id', (req, res) => {
    hitCount += 1;
    const id = req.params.id;
    if (id === String(PUBLIC_DDB_CHARACTER_ID)) {
      res.json({ id: PUBLIC_DDB_CHARACTER_ID, success: true, message: '', data: PUBLIC_DDB_CHARACTER });
      return;
    }
    if (id === String(CASTER_DDB_CHARACTER_ID)) {
      res.json({ id: CASTER_DDB_CHARACTER_ID, success: true, message: '', data: CASTER_DDB_CHARACTER });
      return;
    }
    if (id === '777') {
      // Private / campaign-only sheet: the character service answers 403.
      res.status(403).json({ id: 777, success: false, message: 'You are not authorized', data: null });
      return;
    }
    if (id === '9999') {
      // Public flag off: 200 with success:false and no data.
      res.status(200).json({ id: 9999, success: false, message: 'Character is private', data: null });
      return;
    }
    res.status(404).json({ id: Number(id) || null, success: false, message: 'Not found', data: null });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake DDB server');
  const baseUrl = `http://127.0.0.1:${address.port}/character`;

  return {
    baseUrl,
    server,
    get hitCount() {
      return hitCount;
    },
    resetHitCount() {
      hitCount = 0;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
