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
 *   PUBLIC_CHARACTER.id — a full public sheet (200 success:true)
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
  inventory: [
    { equipped: true, definition: { armorClass: 16, armorTypeId: 3, name: 'Chain Mail' } },
    { equipped: true, definition: { armorClass: 2, armorTypeId: 4, name: 'Shield' } },
    { equipped: false, definition: { armorClass: 12, armorTypeId: 1, name: 'Leather Armor (stowed)' } },
  ],
  modifiers: {
    race: [{ type: 'bonus', subType: 'constitution-score', value: 2 }],
    class: [
      { type: 'proficiency', subType: 'strength-saving-throws', value: null },
      { type: 'proficiency', subType: 'constitution-saving-throws', value: null },
      { type: 'proficiency', subType: 'perception-skill', value: null },
      { type: 'expertise', subType: 'stealth-skill', value: null },
    ],
    background: [],
    item: [],
    feat: [],
    condition: [],
  },
  decorations: { avatarUrl: 'https://www.dndbeyond.com/avatars/thornbeard.png' },
  notes: { backstory: 'A dwarf who left the mountain halls to hunt the orcs that razed his clanhold.' },
};

export interface FakeDdb {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

export async function startFakeDdb(): Promise<FakeDdb> {
  const app = express();

  app.get('/character/:id', (req, res) => {
    const id = req.params.id;
    if (id === String(PUBLIC_DDB_CHARACTER_ID)) {
      res.json({ id: PUBLIC_DDB_CHARACTER_ID, success: true, message: '', data: PUBLIC_DDB_CHARACTER });
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
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake DDB server');
  const baseUrl = `http://127.0.0.1:${address.port}/character`;

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
