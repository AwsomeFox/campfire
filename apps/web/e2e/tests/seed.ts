import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import { type SeedData } from '../global-setup';

// __dirname is provided by Playwright's CJS transform — avoid import.meta here.
const AUTH_DIR = resolve(__dirname, '..', '.auth');

/** Reads the ids written by global-setup.ts. */
export function seed(): SeedData {
  return JSON.parse(readFileSync(resolve(AUTH_DIR, 'seed.json'), 'utf8')) as SeedData;
}

/** Absolute path to a role's captured storageState. */
export function stateFor(role: 'admin' | 'dm' | 'player' | 'viewer'): string {
  return resolve(AUTH_DIR, `${role}.json`);
}

/** 16:9 aspect ratio PNG buffer matching the battle map surface aspect ratio. */
export const PNG_16_9 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAACvn2aAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAARElEQVQoU2NgGAWjYBSMAgAAAQQAAAGn1v8AAAAASUVORUSCYII=',
  'base64',
);

/** Reopens and resets the main seeded encounter using captured DM authentication. */
export async function restoreSeedEncounter(_page?: { request: APIRequestContext }): Promise<void> {
  try {
    const { baseURL, encounterId, endedEncounterId, bossId, skirmisherId } = seed();
    const dmContext = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });
    try {
      await dmContext.post(`/api/v1/encounters/${encounterId}/reopen`).catch(() => undefined);
      await dmContext.patch(`/api/v1/encounters/${encounterId}`, {
        data: {
          round: 1,
          turnIndex: 0,
          combatants: [
            { id: bossId, currentHp: 30, initiative: 18 },
            { id: skirmisherId, currentHp: 12, initiative: 7 },
          ],
        },
      }).catch(() => undefined);
      await dmContext.post(`/api/v1/encounters/${encounterId}/start`).catch(() => undefined);
      await dmContext.post(`/api/v1/encounters/${endedEncounterId}/end`).catch(() => undefined);
    } finally {
      await dmContext.dispose();
    }
  } catch {
    // Ignore if storageState file is not present yet
  }
}
