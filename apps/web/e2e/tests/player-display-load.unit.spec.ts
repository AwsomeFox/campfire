/**
 * Issue #743 — Player Display overlapping-load races.
 *
 * Poll + SSE used to launch uncoordinated summary/list/detail fetches. An older
 * trio finishing after a newer one could paint stale combat back onto the TV,
 * and a detail failure cleared the initiative rail. These specs pin the
 * sequencer + projection fetch (DOM-free) across the acceptance scenarios:
 * reordered responses, poll+SSE bursts, End during load, reconnect/stale, and
 * campaign identity change.
 */
import { expect, test } from '@playwright/test';
import type { CampaignSummary, Encounter, EncounterWithCombatants } from '@campfire/schema';
import { ApiError } from '../../src/lib/api';
import {
  fetchPlayerDisplayProjection,
  PlayerDisplayLoadSequencer,
  playerDisplaySyncMessage,
  playerDisplaySyncState,
  projectionAfterLoadFailure,
  runPlayerDisplayLoad,
  type PlayerDisplayFetchers,
  type PlayerDisplayProjection,
} from '../../src/features/screen/playerDisplayLoad';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function summaryFor(campaignId: number, name: string): CampaignSummary {
  return {
    campaign: { id: campaignId, name, sessionCount: 1 },
  } as unknown as CampaignSummary;
}

function runningEncounter(id: number, campaignId: number, round = 1): Encounter {
  return {
    id,
    campaignId,
    name: `Fight ${id}`,
    status: 'running',
    round,
  } as unknown as Encounter;
}

function detailFor(id: number, campaignId: number, round: number, status: 'running' | 'ended' = 'running'): EncounterWithCombatants {
  return {
    id,
    campaignId,
    name: `Fight ${id}`,
    status,
    round,
    currentCombatantId: 1,
    combatants: [{ id: 1, name: 'Hero', kind: 'character', initiative: 15 }],
  } as unknown as EncounterWithCombatants;
}

function trackAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

test.describe('playerDisplaySyncState (#743)', () => {
  test('live when stream is connected and display is fresh', () => {
    expect(playerDisplaySyncState({
      staleIdentity: false,
      displayStale: false,
      eventStatus: 'connected',
    })).toBe('live');
    expect(playerDisplaySyncMessage('live')).toBeNull();
  });

  test('reconnecting / stale / offline keep last-known messaging', () => {
    expect(playerDisplaySyncState({
      staleIdentity: false,
      displayStale: false,
      eventStatus: 'reconnecting',
    })).toBe('reconnecting');
    expect(playerDisplaySyncMessage('reconnecting')).toMatch(/Reconnecting/);

    expect(playerDisplaySyncState({
      staleIdentity: false,
      displayStale: true,
      eventStatus: 'connected',
    })).toBe('stale');
    expect(playerDisplaySyncMessage('stale')).toMatch(/interrupted/);

    expect(playerDisplaySyncState({
      staleIdentity: true,
      displayStale: false,
      eventStatus: 'connected',
    })).toBe('offline');
    expect(playerDisplaySyncMessage('offline')).toMatch(/Offline/);
  });
});

test.describe('fetchPlayerDisplayProjection (#743)', () => {
  test('commits summary + live detail together', async () => {
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => summaryFor(7, 'Ashfall'),
      getRunningEncounters: async () => [runningEncounter(9, 7, 2)],
      getEncounter: async () => detailFor(9, 7, 2),
    };
    const projection = await fetchPlayerDisplayProjection(7, fetchers, new AbortController().signal);
    expect(projection).toEqual({
      campaignId: 7,
      summary: summaryFor(7, 'Ashfall'),
      encounter: detailFor(9, 7, 2),
    } satisfies PlayerDisplayProjection);
  });

  test('clears the rail when the running list is empty', async () => {
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => summaryFor(7, 'Ashfall'),
      getRunningEncounters: async () => [],
      getEncounter: async () => {
        throw new Error('detail should not be fetched');
      },
    };
    const projection = await fetchPlayerDisplayProjection(7, fetchers, new AbortController().signal);
    expect(projection.encounter).toBeNull();
  });

  test('End during load: detail already ended → no live rail', async () => {
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => summaryFor(7, 'Ashfall'),
      getRunningEncounters: async () => [runningEncounter(9, 7)],
      getEncounter: async () => detailFor(9, 7, 3, 'ended'),
    };
    const projection = await fetchPlayerDisplayProjection(7, fetchers, new AbortController().signal);
    expect(projection.encounter).toBeNull();
  });

  test('End during load: re-check list after detail drops a race winner', async () => {
    let listCalls = 0;
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => summaryFor(7, 'Ashfall'),
      getRunningEncounters: async () => {
        listCalls += 1;
        // First list still sees the fight; the post-detail re-check sees End.
        return listCalls === 1 ? [runningEncounter(9, 7)] : [];
      },
      getEncounter: async () => detailFor(9, 7, 4),
    };
    const projection = await fetchPlayerDisplayProjection(7, fetchers, new AbortController().signal);
    expect(listCalls).toBe(2);
    expect(projection.encounter).toBeNull();
  });
});

test.describe('PlayerDisplayLoadSequencer + runPlayerDisplayLoad (#743)', () => {
  test('poll + SSE burst: only the latest generation commits', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const summaryA = deferred<CampaignSummary>();
    const summaryB = deferred<CampaignSummary>();
    let summaryCalls = 0;

    const fetchers: PlayerDisplayFetchers = {
      getSummary: (_cid, signal) => {
        summaryCalls += 1;
        return trackAbort(signal, summaryCalls === 1 ? summaryA.promise : summaryB.promise);
      },
      getRunningEncounters: async (_cid, signal) => {
        throwIfAborted(signal);
        return [runningEncounter(9, 7, summaryCalls === 1 ? 1 : 5)];
      },
      getEncounter: async (_cid, signal) => {
        throwIfAborted(signal);
        // Round encodes which burst produced the detail.
        return detailFor(9, 7, summaryCalls === 1 ? 1 : 5);
      },
    };

    const first = runPlayerDisplayLoad(sequencer, 7, fetchers);
    const second = runPlayerDisplayLoad(sequencer, 7, fetchers);

    // Older summary resolves AFTER the newer load has already begun — must not win.
    summaryB.resolve(summaryFor(7, 'Ashfall'));
    const secondResult = await second;
    expect(secondResult.kind).toBe('ok');
    if (secondResult.kind === 'ok') {
      expect(secondResult.projection.encounter?.round).toBe(5);
    }

    summaryA.resolve(summaryFor(7, 'Ashfall-stale'));
    const firstResult = await first;
    expect(firstResult.kind).toBe('ignored');
  });

  test('reordered summary/list/detail across overlapping loads cannot regress live state', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();

    type Stages = {
      summary: Deferred<CampaignSummary>;
      list: Deferred<Encounter[]>;
      detail: Deferred<EncounterWithCombatants>;
      recheck: Deferred<Encounter[]>;
      listCalls: number;
    };
    const stagesBySignal = new WeakMap<AbortSignal, Stages>();
    const loads: Stages[] = [];

    function stagesFor(signal: AbortSignal): Stages {
      let stages = stagesBySignal.get(signal);
      if (!stages) {
        stages = {
          summary: deferred(),
          list: deferred(),
          detail: deferred(),
          recheck: deferred(),
          listCalls: 0,
        };
        stagesBySignal.set(signal, stages);
        loads.push(stages);
      }
      return stages;
    }

    const fetchers: PlayerDisplayFetchers = {
      getSummary: async (campaignId, signal) => {
        const stages = stagesFor(signal);
        void campaignId;
        return trackAbort(signal, stages.summary.promise);
      },
      getRunningEncounters: async (_cid, signal) => {
        const stages = stagesFor(signal);
        stages.listCalls += 1;
        return trackAbort(
          signal,
          stages.listCalls === 1 ? stages.list.promise : stages.recheck.promise,
        );
      },
      getEncounter: async (_id, signal) => {
        const stages = stagesFor(signal);
        return trackAbort(signal, stages.detail.promise);
      },
    };

    const loadA = runPlayerDisplayLoad(sequencer, 7, fetchers);
    // Flush microtasks so load A registers its signal-keyed stages.
    await Promise.resolve();
    expect(loads.length).toBe(1);
    const stagesA = loads[0]!;

    const loadB = runPlayerDisplayLoad(sequencer, 7, fetchers);
    await Promise.resolve();
    expect(loads.length).toBe(2);
    const stagesB = loads[1]!;

    // Complete B fully first (live round 5) while A's responses are still pending.
    stagesB.summary.resolve(summaryFor(7, 'Ashfall'));
    stagesB.list.resolve([runningEncounter(9, 7, 5)]);
    stagesB.detail.resolve(detailFor(9, 7, 5));
    stagesB.recheck.resolve([runningEncounter(9, 7, 5)]);
    const b = await loadB;
    expect(b.kind).toBe('ok');
    if (b.kind === 'ok') expect(b.projection.encounter?.round).toBe(5);

    // Late A responses (older round) arrive out of order — must not commit over B.
    // begin(B) already aborted A's signal, so this resolves as ignored even if the
    // deferreds settle with stale round-1 data.
    stagesA.summary.resolve(summaryFor(7, 'Ashfall-stale'));
    stagesA.list.resolve([runningEncounter(9, 7, 1)]);
    stagesA.detail.resolve(detailFor(9, 7, 1));
    stagesA.recheck.resolve([runningEncounter(9, 7, 1)]);
    const a = await loadA;
    expect(a.kind).toBe('ignored');
  });

  test('transient detail/summary failure keeps last-known instead of clearing the rail', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => {
        throw new TypeError('network down');
      },
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(9, 7, 2),
    };

    const result = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: true });
    expect(result).toMatchObject({
      kind: 'failed',
      keepLastKnown: true,
      transient: true,
    });
  });

  test('first-load failure still surfaces an error (nothing to keep)', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => {
        throw new ApiError(500, 'server exploded');
      },
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(9, 7, 2),
    };

    const result = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: false });
    expect(result).toMatchObject({
      kind: 'failed',
      keepLastKnown: false,
      message: 'server exploded',
    });
  });

  test('persistent 404 after summary keeps cast and drops only the rail', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const prior: PlayerDisplayProjection = {
      campaignId: 7,
      summary: summaryFor(7, 'Ashfall'),
      encounter: detailFor(9, 7, 2),
    };
    const freshSummary = summaryFor(7, 'Ashfall Renewed');
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => freshSummary,
      getRunningEncounters: async () => [runningEncounter(9, 7)],
      getEncounter: async () => {
        throw new ApiError(404, 'Encounter not found');
      },
    };

    const result = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: true });
    expect(result).toMatchObject({
      kind: 'failed',
      keepLastKnown: false,
      transient: false,
      message: 'Encounter not found',
      summary: freshSummary,
    });
    // Page applies this helper when keepLastKnown is false — rail drops, cast stays.
    expect(
      projectionAfterLoadFailure(prior, 7, { keepLastKnown: false, summary: result.kind === 'failed' ? result.summary : null }),
    ).toEqual({
      campaignId: 7,
      summary: freshSummary,
      encounter: null,
    });
    // Transient path still leaves the prior paint untouched.
    expect(projectionAfterLoadFailure(prior, 7, { keepLastKnown: true })).toBe(prior);
    // Other campaign's paint is left alone when this campaign has no summary to keep.
    const other = { ...prior, campaignId: 99 };
    expect(projectionAfterLoadFailure(other, 7, { keepLastKnown: false, summary: null })).toBe(other);
  });

  test('persistent summary 404 clears projection (full-screen path)', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const prior: PlayerDisplayProjection = {
      campaignId: 7,
      summary: summaryFor(7, 'Ashfall'),
      encounter: detailFor(9, 7, 2),
    };
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => {
        throw new ApiError(404, 'Campaign not found');
      },
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(9, 7, 2),
    };

    const result = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: true });
    expect(result).toMatchObject({
      kind: 'failed',
      keepLastKnown: false,
      transient: false,
      message: 'Campaign not found',
      summary: null,
    });
    expect(
      projectionAfterLoadFailure(prior, 7, { keepLastKnown: false, summary: null }),
    ).toBeNull();
  });

  test('first-load persistent detail 404 still keeps the fetched summary', async () => {
    // Pre-#743 nested try/catch: summary success + encounter failure painted the
    // cast and cleared only the rail — never a full-screen wipe.
    const sequencer = new PlayerDisplayLoadSequencer();
    const summary = summaryFor(7, 'Ashfall');
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => summary,
      getRunningEncounters: async () => [runningEncounter(9, 7)],
      getEncounter: async () => {
        throw new ApiError(403, 'Forbidden');
      },
    };

    const result = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: false });
    expect(result).toMatchObject({
      kind: 'failed',
      keepLastKnown: false,
      transient: false,
      message: 'Forbidden',
      summary,
    });
    expect(
      projectionAfterLoadFailure(null, 7, {
        keepLastKnown: false,
        summary: result.kind === 'failed' ? result.summary : null,
      }),
    ).toEqual({ campaignId: 7, summary, encounter: null });
  });

  test('campaign identity change invalidates in-flight work for the prior id', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const summaryA = deferred<CampaignSummary>();

    const fetchersA: PlayerDisplayFetchers = {
      getSummary: (_cid, signal) => trackAbort(signal, summaryA.promise),
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(1, 1, 1),
    };
    const fetchersB: PlayerDisplayFetchers = {
      getSummary: async () => summaryFor(2, 'Other'),
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(1, 2, 1),
    };

    const loadA = runPlayerDisplayLoad(sequencer, 1, fetchersA);
    const loadB = runPlayerDisplayLoad(sequencer, 2, fetchersB);
    const b = await loadB;
    expect(b.kind).toBe('ok');
    if (b.kind === 'ok') {
      expect(b.projection.campaignId).toBe(2);
      expect(b.projection.summary.campaign.name).toBe('Other');
    }

    summaryA.resolve(summaryFor(1, 'Should-not-commit'));
    const a = await loadA;
    expect(a.kind).toBe('ignored');
  });

  test('reconnect path: a new generation after invalidate commits fresh state', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => summaryFor(7, 'Ashfall'),
      getRunningEncounters: async () => [runningEncounter(9, 7, 6)],
      getEncounter: async () => detailFor(9, 7, 6),
    };

    // Simulate a dropped stream aborting the in-flight poll, then onReconnect.
    const hung = deferred<CampaignSummary>();
    const hungFetchers: PlayerDisplayFetchers = {
      getSummary: (_cid, signal) => trackAbort(signal, hung.promise),
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(9, 7, 1),
    };
    const dropped = runPlayerDisplayLoad(sequencer, 7, hungFetchers);
    sequencer.invalidate(); // stream drop / identity churn (single bump)
    const reconnected = await runPlayerDisplayLoad(sequencer, 7, fetchers);
    expect(reconnected.kind).toBe('ok');
    if (reconnected.kind === 'ok') {
      expect(reconnected.projection.encounter?.round).toBe(6);
    }
    hung.resolve(summaryFor(7, 'stale'));
    expect((await dropped).kind).toBe('ignored');
  });

  test('TimeoutError is a transient failure, not an ignored abort', async () => {
    // First-load timeouts must not return `ignored` (page would keep loading forever).
    const sequencer = new PlayerDisplayLoadSequencer();
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => {
        throw timeout;
      },
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(9, 7, 2),
    };

    const firstLoad = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: false });
    expect(firstLoad).toMatchObject({
      kind: 'failed',
      keepLastKnown: false,
      transient: true,
      message: 'The operation was aborted due to timeout',
    });

    const refresh = await runPlayerDisplayLoad(sequencer, 7, fetchers, { hadProjection: true });
    expect(refresh).toMatchObject({
      kind: 'failed',
      keepLastKnown: true,
      transient: true,
    });
  });

  test('AbortError / signal.aborted still classify as ignored', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const hung = deferred<CampaignSummary>();
    const fetchers: PlayerDisplayFetchers = {
      getSummary: (_cid, signal) => trackAbort(signal, hung.promise),
      getRunningEncounters: async () => [],
      getEncounter: async () => detailFor(9, 7, 1),
    };
    const inFlight = runPlayerDisplayLoad(sequencer, 7, fetchers);
    // Superseding begin aborts the prior signal → ignored, not failed.
    sequencer.begin(7);
    hung.resolve(summaryFor(7, 'stale'));
    expect((await inFlight).kind).toBe('ignored');
  });

  test('campaign change: cleanup invalidate once, then begin — no double bump', () => {
    // Mirrors PlayerDisplayPage: React cleanup invalidates; the next effect body
    // must NOT invalidate again before load()/begin().
    const sequencer = new PlayerDisplayLoadSequencer();
    const prior = sequencer.begin(1);
    const genAfterPrior = sequencer.currentGeneration;

    sequencer.invalidate(); // previous effect cleanup only
    expect(sequencer.currentGeneration).toBe(genAfterPrior + 1);
    expect(prior.signal.aborted).toBe(true);
    expect(sequencer.activeCampaign).toBeNull();

    const next = sequencer.begin(2); // new effect → load()
    expect(next.generation).toBe(genAfterPrior + 2);
    expect(sequencer.isCurrent(next.generation, 2)).toBe(true);
  });

  test('begin() aborts the prior signal', async () => {
    const sequencer = new PlayerDisplayLoadSequencer();
    const first = sequencer.begin(7);
    expect(first.signal.aborted).toBe(false);
    const second = sequencer.begin(7);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(sequencer.isCurrent(first.generation, 7)).toBe(false);
    expect(sequencer.isCurrent(second.generation, 7)).toBe(true);
  });

  test('generation guard ignores stale commits even when a fetch ignores abort', async () => {
    // Some runtimes deliver an already-buffered body after abort(). The
    // monotonic generation check is the backstop that still drops the stale paint.
    const sequencer = new PlayerDisplayLoadSequencer();
    const summaryA = deferred<CampaignSummary>();
    let calls = 0;

    const fetchers: PlayerDisplayFetchers = {
      getSummary: async () => {
        calls += 1;
        if (calls === 1) return summaryA.promise; // intentionally ignores signal
        return summaryFor(7, 'Ashfall');
      },
      getRunningEncounters: async () => [runningEncounter(9, 7, calls === 1 ? 1 : 8)],
      getEncounter: async () => detailFor(9, 7, calls === 1 ? 1 : 8),
    };

    const stale = runPlayerDisplayLoad(sequencer, 7, fetchers);
    const fresh = runPlayerDisplayLoad(sequencer, 7, fetchers);
    const freshResult = await fresh;
    expect(freshResult.kind).toBe('ok');
    if (freshResult.kind === 'ok') expect(freshResult.projection.encounter?.round).toBe(8);

    summaryA.resolve(summaryFor(7, 'Ashfall-stale'));
    const staleResult = await stale;
    expect(staleResult.kind).toBe('ignored');
  });
});

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
