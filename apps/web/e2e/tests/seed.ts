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
    //
    // Issue #2092: a test that fails mid-run can itself be interrupted by
    // Playwright's own per-test timeout before ITS finally block finishes ending
    // its throwaway encounter, leaving that encounter running when THIS function
    // runs (either as that same test's own teardown, racing the abort, or as the
    // next test's setup). A single end-then-throw pass here used to give up on
    // the very first non-2xx/400 response and abort the whole sweep, then throw
    // immediately on the first ENCOUNTER_ALREADY_RUNNING from `/reopen` — masking
    // whatever assertion actually failed with a teardown error that then repeats
    // on every subsequent run, since nothing ever retried the sweep. Sweep + reopen
    // are now retried as a bounded unit so a leftover encounter (however it was
    // left running) gets swept before we give up.
    const sweepLiveFights = async (): Promise<void> => {
      const liveRes = await dm.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`);
      if (!liveRes.ok()) return;
      for (const enc of (await liveRes.json()) as { id: number }[]) {
        if (enc.id === encounterId) continue;
        const ended = await dm.post(`/api/v1/encounters/${enc.id}/end`);
        // 400 (not running / already ended) and 404 (deleted by its own cleanup
        // after we listed it) both mean the slot is already free — keep sweeping
        // the rest rather than aborting on the first one that isn't a clean 2xx.
        if (!ended.ok() && ended.status() !== 400 && ended.status() !== 404) {
          // Diagnostic only — the caller retries the sweep, so one bad entry here must
          // not abort ending the rest of the running encounters in this campaign.
          console.warn(`restoreSeedEncounter: end other live fight ${enc.id} -> ${ended.status()}: ${await readError(ended)}`);
        }
      }
    };

    const getAmbush = async (): Promise<{ status: string; combatants?: Array<{ id: number }> }> => {
      const res = await dm.get(`/api/v1/encounters/${encounterId}`);
      if (!res.ok()) throw new Error(`GET seed encounter -> ${res.status()}: ${await readError(res)}`);
      return (await res.json()) as { status: string; combatants?: Array<{ id: number }> };
    };

    let status: string | undefined;
    const REOPEN_ATTEMPTS = 4;
    let lastReopenFailure: string | null = null;
    for (let attempt = 0; attempt < REOPEN_ATTEMPTS; attempt++) {
      await sweepLiveFights();
      const ambushData = await getAmbush();
      status = ambushData.status;
      if (status !== 'ended') {
        lastReopenFailure = null;
        break;
      }

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
        } else if (body.code === 'ENCOUNTER_ALREADY_RUNNING') {
          // Something is still running — a leftover from an aborted test, or a
          // narrow race with a concurrent worker on this same fixture. Retry the
          // sweep-and-reopen cycle rather than giving up on the first attempt.
          lastReopenFailure = `reopen seed encounter -> 409 ENCOUNTER_ALREADY_RUNNING (attempt ${attempt + 1}/${REOPEN_ATTEMPTS})`;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
      }
      if (!reopenRes.ok()) {
        throw new Error(`reopen seed encounter -> ${reopenRes.status()}: ${await readError(reopenRes)}`);
      }
      status = 'running';
      lastReopenFailure = null;
      break;
    }
    if (lastReopenFailure) {
      throw new Error(`${lastReopenFailure} — a running encounter kept blocking reopen after ${REOPEN_ATTEMPTS} sweep attempts`);
    }

    const currentAmbush = await getAmbush();
    if (Array.isArray(currentAmbush.combatants)) {
      for (const c of currentAmbush.combatants) {
        if (c.id !== bossId && c.id !== skirmisherId) {
          await dm.delete(`/api/v1/encounters/${encounterId}/combatants/${c.id}`).catch(() => undefined);
        }
      }
    }

    // Reset each seed combatant's HP / initiative / condition / death-save / turn state.
    // NOTE: initiative must be reset here, BEFORE the round/turn rewind below, so the
    // rewind loop's sort order converges on `bossId` deterministically. The
    // `conditionInstances` reset is repeated a second time AFTER the rewind (see below) —
    // `/undo-turn` can restore an expired condition from its turn-tick snapshot
    // (`applyConditionTickDelta` in encounters.service.ts), which would otherwise silently
    // undo this reset and leak stale conditions into the next test.
    const seedCombatants = [
      { id: bossId, hpSet: 30, initiative: 18 },
      { id: skirmisherId, hpSet: 12, initiative: 7 },
    ];
    for (const c of seedCombatants) {
      const patchRes = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`, {
        data: {
          hpSet: c.hpSet,
          initiative: c.initiative,
          deathSaveSuccesses: 0,
          deathSaveFailures: 0,
          deathState: 'none',
          conditionInstances: [],
          hpTemp: 0,
        },
      });
      if (!patchRes.ok()) {
        throw new Error(
          `patch seed combatant ${c.id} -> ${patchRes.status()}: ${await readError(patchRes)}`,
        );
      }
      // `resetTurn` only clears the per-turn slice (`used` + `movementUsedFt` —
      // encounters.service.ts:7474-7477, matching the schema comment at
      // index.ts:10791). `delaying`/`readied` are a separate pair of turn-order flags on
      // the same endpoint (index.ts:10809-10810) and are NOT touched by `resetTurn`, so a
      // spec that leaves a seed combatant delaying or with a readied action would
      // otherwise leak that into the next test. Clear them explicitly in the same request.
      // Concentration is intentionally left alone — resetTurn's own doc comment says it's
      // kept, and no spec against this shared fixture sets it today.
      const turnRes = await dm.post(`/api/v1/encounters/${encounterId}/combatants/${c.id}/turn-state`, {
        data: { resetTurn: true, delaying: false, readied: null },
      });
      if (!turnRes.ok()) {
        throw new Error(
          `reset seed combatant turn-state ${c.id} -> ${turnRes.status()}: ${await readError(turnRes)}`,
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

    // Re-clear conditionInstances now that the rewind above has settled: each `/undo-turn`
    // call can restore an expired condition from its turn-tick snapshot (issue #1445 —
    // `applyConditionTickDelta` in encounters.service.ts), so a condition cleared by the
    // reset pass earlier can reappear partway through the rewind loop. Repeating the clear
    // here, after the loop, is the only way to guarantee a clean seed state.
    for (const c of seedCombatants) {
      const reclearRes = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`, {
        data: { conditionInstances: [] },
      });
      if (!reclearRes.ok()) {
        throw new Error(
          `re-clear seed combatant conditions ${c.id} -> ${reclearRes.status()}: ${await readError(reclearRes)}`,
        );
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
