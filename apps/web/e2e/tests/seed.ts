import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { type SeedData } from '../global-setup';

// __dirname is provided by Playwright's CJS transform — avoid import.meta here.
const AUTH_DIR = resolve(__dirname, '..', '.auth');

let cachedSeed: SeedData | null = null;

function createFallbackProxy(): unknown {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => '1';
      }
      if (prop === 'then') {
        return undefined;
      }
      return createFallbackProxy();
    },
    apply() {
      return createFallbackProxy();
    },
  });
}

function getSeedData(): SeedData {
  if (cachedSeed) return cachedSeed;
  const seedPath = resolve(AUTH_DIR, 'seed.json');
  if (existsSync(seedPath)) {
    cachedSeed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedData;
    return cachedSeed;
  }
  return createFallbackProxy() as SeedData;
}

/** Returns whether global-setup.ts has written seed.json. */
export function hasSeedData(): boolean {
  return existsSync(resolve(AUTH_DIR, 'seed.json'));
}

/** Reads the ids written by global-setup.ts (evaluated lazily on property access). */
export function seed(): SeedData {
  return new Proxy({} as SeedData, {
    get(_target, prop, receiver) {
      const data = getSeedData();
      return Reflect.get(data, prop, receiver);
    },
  });
}

/** Absolute path to a role's captured storageState. */
export function stateFor(role: 'admin' | 'dm' | 'player' | 'viewer'): string {
  return resolve(AUTH_DIR, `${role}.json`);
}

/**
 * A real, decodable 16x9 PNG (8-bit RGB, one IDAT, correct chunk CRCs) — 16:9 so it matches the
 * battle-map surface's aspect ratio and fills it without letterboxing, which keeps the grid and
 * calibration overlays' contained-rect maths trivial.
 *
 * The previous buffer here was NOT a decodable PNG (issue #1609): its IHDR CRC did not match and
 * its IDAT header was malformed. That stayed invisible for as long as every consumer handed the
 * bytes to `route.fulfill`, because Chromium renders leniently and nothing in the suite decoded
 * it strictly. The moment a spec POSTs it to the real attachment endpoint — which decodes the
 * upload to derive dimensions — the server answers
 * `400 Input buffer has corrupt header: pngload_buffer: invalid chunk checksum`, an error that
 * names libvips and not the fixture, so it reads as an upload-endpoint bug. Keep this buffer
 * strictly valid: run the chunk-CRC check in #1609 over any replacement rather than trusting
 * that it renders.
 */
export const PNG_16_9 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAIUlEQVR42mOwsveGIzlFTTjCJc4wCDUQowhZfDBqINXTALwBVGFnWt94AAAAAElFTkSuQmCC',
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
  if (!hasSeedData()) {
    // global-setup has not written seed.json yet (or the worker cannot see it).
    return;
  }

  const { baseURL, campaignId, encounterId, endedEncounterId, bossId, skirmisherId } = seed();
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

    const getAmbush = async (): Promise<{ status: string; combatants?: Array<{ id: number }> }> => {
      const res = await dm.get(`/api/v1/encounters/${encounterId}`);
      if (!res.ok()) throw new Error(`GET seed encounter -> ${res.status()}: ${await readError(res)}`);
      return (await res.json()) as { status: string; combatants?: Array<{ id: number }> };
    };

    const ambushData = await getAmbush();
    let status = ambushData.status;

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

    const currentAmbush = await getAmbush();
    if (Array.isArray(currentAmbush.combatants)) {
      for (const c of currentAmbush.combatants) {
        if (c.id !== bossId && c.id !== skirmisherId) {
          await dm.delete(`/api/v1/encounters/${encounterId}/combatants/${c.id}`).catch(() => undefined);
        }
      }
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

    // /reopen preserves the turn pointer from a prior run. Step it back to round 1,
    // boss first so every consumer has a deterministic starting turn (issue #1694).
    let finalState: { round: number; currentCombatantId: number | null } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const stateRes = await dm.get(`/api/v1/encounters/${encounterId}`);
      if (!stateRes.ok()) {
        throw new Error(`verify seed encounter state -> ${stateRes.status()}: ${await readError(stateRes)}`);
      }
      const state = (await stateRes.json()) as { round: number; currentCombatantId: number | null };
      finalState = state;
      if (state.round === 1 && state.currentCombatantId === bossId) break;
      const undoRes = await dm.post(`/api/v1/encounters/${encounterId}/undo-turn`);
      if (!undoRes.ok()) {
        throw new Error(`rewind seed encounter turn -> ${undoRes.status()}: ${await readError(undoRes)}`);
      }
    }
    if (!finalState || finalState.round !== 1 || finalState.currentCombatantId !== bossId) {
      throw new Error(`seed encounter turn did not rewind to round 1 / boss (got ${JSON.stringify(finalState)})`);
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
