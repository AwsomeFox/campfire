/**
 * Issue #1908 rework — cast-token X-Card safety poll sequencing.
 *
 * `GET /cast/:token/safety` is polled on a fixed interval. Two review findings
 * on the same code, addressed here together:
 *
 *  1. (P1) Overlapping polls can complete out of order — a slow pre-hold
 *     `false` resolving after a fresh post-hold `true` must not clear the
 *     safety curtain while the X-Card is still raised.
 *  2. (P1, found on the first fix's own diff) Naively aborting whichever poll
 *     is in flight every time a new tick fires closes (1) but opens
 *     starvation: if every response takes longer than the interval, each new
 *     tick cancels the last before it can ever complete, and the display can
 *     sit at its initial `false` forever even while a hold is active.
 *
 * The shipped design never overlaps requests at all — a tick that finds one
 * already in flight is skipped, not aborted — so (1) cannot happen (nothing
 * to be superseded by) and (2) cannot happen (a slow request is left alone to
 * finish). These specs pin `CastSafetyPollSequencer` + `runCastSafetyPoll`
 * (DOM-free) against both, mirroring `player-display-load.unit.spec.ts`'s
 * deferred-promise technique.
 */
import { expect, test } from '@playwright/test';
import type { CastSafetyState } from '@campfire/schema';
import {
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
