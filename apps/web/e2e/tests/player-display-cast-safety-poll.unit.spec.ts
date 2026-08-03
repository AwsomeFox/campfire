/**
 * Issue #1908 rework — cast-token X-Card safety poll sequencing.
 *
 * `GET /cast/:token/safety` is polled on a fixed interval. Four review
 * findings on the same code, addressed here together:
 *
 *  1. (P1) Overlapping polls can complete out of order — a slow pre-hold
 *     `false` resolving after a fresh post-hold `true` must not clear the
 *     safety curtain while the X-Card is still raised.
 *  2. (P1, found on the first fix's own diff) Naively aborting whichever poll
 *     is in flight every time a new tick fires closes (1) but opens
 *     starvation: if every response takes longer than the interval, each new
 *     tick cancels the last before it can ever complete, and the display can
 *     sit at its initial `false` forever even while a hold is active.
 *  3. (P1, found on the second fix's own diff) Skipping a tick while one is
 *     in flight — instead of aborting — closes (2) but reopens a narrower
 *     starvation mode: with no deadline, a single request that stalls (the
 *     connection hangs, no response ever arrives) leaves the flight flag
 *     latched forever, silently disabling every later tick.
 *  4. (P1, found on the third fix's own diff) The 4s deadline that fixed (3)
 *     was itself too tight — under the 5s poll interval sounds safe, but an
 *     endpoint that healthily and consistently responds in the 4–5s band
 *     would have every single request aborted before completion, so the
 *     poll could never resolve `ok` at all. The deadline must be generous
 *     relative to normal latency (several poll intervals), not merely
 *     shorter than one tick.
 *
 * The shipped design never overlaps requests (closing 1 and 2 — nothing to be
 * superseded by, and a slow-but-completing request is left alone to finish),
 * and every request carries a generous deadline that aborts it and releases
 * the flight flag in a `finally` only if it never settles on its own (closing
 * 3 without reopening 4). These specs pin `CastSafetyPollSequencer` +
 * `runCastSafetyPoll` (DOM-free) against all four, mirroring
 * `player-display-load.unit.spec.ts`'s deferred-promise technique.
 */
import { expect, test } from '@playwright/test';
import type { CastSafetyState } from '@campfire/schema';
import {
  CAST_SAFETY_POLL_TIMEOUT_MS,
  CastSafetyPollSequencer,
  runCastSafetyPoll,
  type CastSafetyFetcher,
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

test.describe('CastSafetyPollSequencer + runCastSafetyPoll (#1908 rework)', () => {
  test('the P1 race: a slow poll cannot be overlapped, so an out-of-order response is impossible', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const slowPoll = deferred<CastSafetyState>();
    let calls = 0;

    const fetchSafety: CastSafetyFetcher = async () => {
      calls += 1;
      // Tick 1 (pre-hold): outruns the interval, still pending.
      if (calls === 1) return slowPoll.promise;
      // A tick fired while tick 1 is still in flight must never reach here.
      throw new Error('overlapping fetch — should have been skipped');
    };

    const first = runCastSafetyPoll(sequencer, fetchSafety);
    // The next poll tick (post-hold, active) fires before tick 1 resolves.
    const overlapping = await runCastSafetyPoll(sequencer, fetchSafety);
    expect(overlapping).toEqual({ kind: 'skipped' });

    // Tick 1 finally resolves (pre-hold, inactive) — nothing has raced it, so
    // its own (correctly ordered, if stale-looking) value simply commits.
    slowPoll.resolve({ active: false });
    const firstResult = await first;
    expect(firstResult).toMatchObject({ kind: 'ok', active: false });

    // With the poll no longer in flight, the next tick actually runs and can
    // now report the true post-hold state.
    calls = 0;
    const second = await runCastSafetyPoll(sequencer, async () => ({ active: true }));
    expect(second).toMatchObject({ kind: 'ok', active: true });
  });

  test('starvation regression: a persistently slow poll is left to finish, not restarted every tick', async () => {
    // The naive fix (abort-on-every-tick) would cancel this request on every
    // subsequent tick and it would never resolve, leaving castSafetyActive at
    // its initial `false` forever even though a hold is active. Skipping
    // overlapping ticks instead means the slow request is untouched and does
    // eventually commit.
    const sequencer = new CastSafetyPollSequencer();
    const slowPoll = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowPoll.promise);

    const first = runCastSafetyPoll(sequencer, fetchSafety);
    // Several more ticks fire while the first is still outstanding — none may
    // abort it or start a competing fetch.
    for (let i = 0; i < 5; i += 1) {
      const tick = await runCastSafetyPoll(sequencer, fetchSafety);
      expect(tick).toEqual({ kind: 'skipped' });
    }

    slowPoll.resolve({ active: true });
    const firstResult = await first;
    expect(firstResult).toMatchObject({ kind: 'ok', active: true });
  });

  test('deadline regression: a stalled (never-resolving) request cannot latch the poll forever', async () => {
    // Skip-not-abort (the starvation fix above) reopens a narrower starvation
    // mode with no deadline: a request whose connection hangs and never
    // settles on its own would leave `inFlight` true forever, silently
    // disabling every later tick — the display would never learn a hold went
    // active. A short `timeoutMs` here stands in for the production
    // (generous, 30s) deadline so the test doesn't need to wait for it.
    const sequencer = new CastSafetyPollSequencer();
    const neverSettles: CastSafetyFetcher = (signal) =>
      trackAbort(signal, new Promise<CastSafetyState>(() => {})); // no resolve/reject — only the deadline ends this

    const stalled = runCastSafetyPoll(sequencer, neverSettles, { timeoutMs: 20 });

    // Before the deadline fires, a tick is correctly skipped — still the
    // only-one-request-in-flight invariant from the starvation fix.
    const midflightTick = await runCastSafetyPoll(sequencer, async () => ({ active: true }), {
      timeoutMs: 20,
    });
    expect(midflightTick).toEqual({ kind: 'skipped' });

    // The deadline aborts the stalled request; it must never be read as "no
    // hold" — it resolves `ignored`, not `ok`.
    const stalledResult = await stalled;
    expect(stalledResult.kind).toBe('ignored');
    expect(sequencer.isInFlight).toBe(false);

    // With the gate released, the next tick actually runs and can observe an
    // active hold — the stall delayed this by at most one deadline, not
    // forever.
    const recovered = await runCastSafetyPoll(sequencer, async () => ({ active: true }), {
      timeoutMs: 20,
    });
    expect(recovered).toMatchObject({ kind: 'ok', active: true });
  });

  test('deadline releases the flight flag on a genuine (non-timeout) failure too — finally, not just the try path', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    const result = await runCastSafetyPoll(sequencer, failing, { timeoutMs: 20 });
    expect(result.kind).toBe('failed');
    expect(sequencer.isInFlight).toBe(false);

    // Not stuck behind a leaked timer either — an immediate next poll runs.
    const next = await runCastSafetyPoll(sequencer, async () => ({ active: true }), { timeoutMs: 20 });
    expect(next).toMatchObject({ kind: 'ok', active: true });
  });

  test('regression: a slow-but-completing response must not be aborted by too tight a deadline', async () => {
    // This pins the P1 in the deadline itself: the first version set it to 4s
    // "under the 5s interval", which means an endpoint that healthily and
    // consistently responds in the 4-5s band would have EVERY request
    // aborted before it could complete — runCastSafetyPoll would never
    // resolve `ok`. The deadline here is deliberately generous relative to
    // the response time (10x), matching production's several-poll-intervals
    // margin, so a response that is merely slow — not stalled — must land.
    const sequencer = new CastSafetyPollSequencer();
    const slowButHealthy = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowButHealthy.promise);

    const pending = runCastSafetyPoll(sequencer, fetchSafety, { timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 40)); // "slow" relative to one tick...
    expect(sequencer.isInFlight).toBe(true); // ...but must not have been aborted yet.
    slowButHealthy.resolve({ active: true });

    const result = await pending;
    expect(result).toMatchObject({ kind: 'ok', active: true });
  });

  test('the production deadline is generous relative to normal latency, not merely under one poll interval', () => {
    // A regression guard on the constant itself, not just behavior: the
    // wrong-shaped 4s value would also pass a "resolves before the deadline"
    // behavioral test if that test's own timing were too generous. Pin that
    // the shipped deadline is comfortably multiple poll intervals (5s each),
    // not a fraction of one.
    expect(CAST_SAFETY_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  test('a genuine failure on the in-flight request fails safe (does not clear the curtain)', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const fetchSafety: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    const result = await runCastSafetyPoll(sequencer, fetchSafety);
    expect(result.kind).toBe('failed');
    // The caller (loadCastSafety) only calls setCastSafetyActive on 'ok' — a
    // 'failed' result carries no value, so it can never strand an unsafe false.

    // The sequencer is released after the failure — the next tick can retry.
    const retry = await runCastSafetyPoll(sequencer, async () => ({ active: true }));
    expect(retry).toMatchObject({ kind: 'ok', active: true });
  });

  test('invalidate() aborts an in-flight poll; its late settle cannot clobber a fresh poll started after', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const hung = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const inFlight = runCastSafetyPoll(sequencer, fetchSafety);
    sequencer.invalidate(); // unmount / cast token change

    // A fresh poll starts right away (e.g. cast mode re-entered) — must not be
    // blocked by the old (aborted, still-unsettled) request.
    const freshInFlight = runCastSafetyPoll(sequencer, (signal) =>
      trackAbort(signal, Promise.resolve({ active: true })),
    );

    // The stale request's underlying promise settles late, after the fresh
    // poll already began — its result must be classified `ignored` and must
    // not clear the new poll's in-flight flag out from under it.
    hung.resolve({ active: false });
    const staleResult = await inFlight;
    expect(staleResult.kind).toBe('ignored');

    const freshResult = await freshInFlight;
    expect(freshResult).toMatchObject({ kind: 'ok', active: true });
  });

  test('begin()/end(): a poll blocks the next tick until it settles, then releases the gate', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const first = sequencer.begin();
    expect(first).not.toBeNull();
    expect(sequencer.isInFlight).toBe(true);
    expect(sequencer.begin()).toBeNull(); // still in flight — blocked

    sequencer.end(first!.token);
    expect(sequencer.isInFlight).toBe(false);
    const second = sequencer.begin();
    expect(second).not.toBeNull();
  });

  test('end() with a stale token (already invalidated) is a no-op', () => {
    const sequencer = new CastSafetyPollSequencer();
    const begun = sequencer.begin();
    expect(begun).not.toBeNull();
    sequencer.invalidate();
    expect(sequencer.isInFlight).toBe(false);

    const fresh = sequencer.begin();
    expect(fresh).not.toBeNull();
    // The stale token's late `end()` must not release the fresh poll's gate.
    sequencer.end(begun!.token);
    expect(sequencer.isInFlight).toBe(true);
  });
});
