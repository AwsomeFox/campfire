import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
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

async function readError(res: APIResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `(status ${res.status()})`;
  }
}

/**
 * Reopens and resets the main seeded "Ambush" encounter as the campaign's single
 * RUNNING live fight (issue #744). Uses a dedicated DM APIRequestContext so page
 * sessions (player/viewer) are never polluted by a mid-test login.
 *
 * `/reopen` transitions ended → running (not preparing). `/start` only accepts
 * preparing, so restore must branch on the current status instead of blindly
 * chaining reopen+start and swallowing failures.
 */
export async function restoreSeedEncounter(_page?: { request: APIRequestContext }): Promise<void> {
  let seeded: SeedData;
  try {
    seeded = seed();
  } catch {
    // global-setup has not written seed.json yet (or the worker cannot see it).
    return;
  }

  const { baseURL, campaignId, encounterId, endedEncounterId, bossId, skirmisherId } = seeded;
  const dm = await request.newContext({
    baseURL: baseURL || undefined,
    storageState: stateFor('dm'),
  });

  try {
    // Free the single live-fight slot so Ambush can become RUNNING again. Throwaway
    // drills (combat-dice / combat-mobile / combat-log) end Ambush, start their own
    // fight, and may leave that fight running if cleanup delete fails — reopen then
    // 409s with ENCOUNTER_ALREADY_RUNNING and the silent catch left Ambush ended.
    const liveRes = await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`);
    if (liveRes.ok()) {
      for (const enc of (await liveRes.json()) as { id: number }[]) {
        if (enc.id === encounterId) continue;
        const ended = await dm.post(`/api/v1/encounters/${enc.id}/end`);
        if (!ended.ok() && ended.status() !== 400) {
          throw new Error(`end other live fight ${enc.id} -> ${ended.status()}: ${await readError(ended)}`);
        }
      }
    }

    const getAmbush = async (): Promise<{ status: string }> => {
      const res = await dm.get(`/api/v1/encounters/${encounterId}`);
      if (!res.ok()) throw new Error(`GET seed encounter -> ${res.status()}: ${await readError(res)}`);
      return (await res.json()) as { status: string };
    };

    let { status } = await getAmbush();

    if (status === 'ended') {
      // /reopen → running (preserving round/turn). May 409 with HP_SYNC_CONFLICT when
      // character sheets advanced after the previous End — resolve keep_combatant so
      // the seed fight resumes with its snapshot values.
      let reopenRes = await dm.post(`/api/v1/encounters/${encounterId}/reopen`, { data: {} });
      if (!reopenRes.ok() && reopenRes.status() === 409) {
        const body = (await reopenRes.json()) as {
          code?: string;
          conflicts?: Array<{ combatantId: number }>;
        };
        if (body.code === 'HP_SYNC_CONFLICT' && Array.isArray(body.conflicts)) {
          reopenRes = await dm.post(`/api/v1/encounters/${encounterId}/reopen`, {
            data: {
              hpResync: body.conflicts.map((c) => ({
                combatantId: c.combatantId,
                direction: 'keep_combatant' as const,
              })),
            },
          });
        }
      }
      if (!reopenRes.ok()) {
        throw new Error(`reopen seed encounter -> ${reopenRes.status()}: ${await readError(reopenRes)}`);
      }
      status = 'running';
    }

    // Reset each seed combatant's HP / initiative. EncounterUpdate does not accept
    // round/turnIndex/combatants (lifecycle endpoints own those); prior restore helpers
    // patched unrecognized keys and silently no-op'd under .catch().
    for (const c of [
      { id: bossId, hpSet: 30, initiative: 18 },
      { id: skirmisherId, hpSet: 12, initiative: 7 },
    ]) {
      const patchRes = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`, {
        data: { hpSet: c.hpSet, initiative: c.initiative },
      });
      if (!patchRes.ok()) {
        throw new Error(
          `patch seed combatant ${c.id} -> ${patchRes.status()}: ${await readError(patchRes)}`,
        );
      }
    }

    if (status === 'preparing') {
      const startRes = await dm.post(`/api/v1/encounters/${encounterId}/start`);
      if (!startRes.ok()) {
        throw new Error(`start seed encounter -> ${startRes.status()}: ${await readError(startRes)}`);
      }
    }

    // Keep the dedicated ended fixture ended if a prior test revived it.
    const endedGet = await dm.get(`/api/v1/encounters/${endedEncounterId}`);
    if (endedGet.ok()) {
      const ended = (await endedGet.json()) as { status: string };
      if (ended.status === 'running') {
        const endRes = await dm.post(`/api/v1/encounters/${endedEncounterId}/end`);
        if (!endRes.ok()) {
          throw new Error(`end ended-fixture -> ${endRes.status()}: ${await readError(endRes)}`);
        }
      }
    }

    const verified = await getAmbush();
    if (verified.status !== 'running') {
      throw new Error(`restoreSeedEncounter expected running, got ${verified.status}`);
    }
  } finally {
    await dm.dispose();
  }
}
