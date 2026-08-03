/**
 * Issue #1908 rework — cast-token X-Card safety poll out-of-order race.
 *
 * `GET /cast/:token/safety` is polled on a fixed interval with no cancellation.
 * A request that takes longer than the interval can overlap the next one, and
 * an unconditional "apply whatever comes back" update lets a slow pre-hold
 * `false` resolve AFTER a fresh post-hold `true` already landed — removing the
 * safety curtain while the X-Card is still raised. These specs pin
 * `CastSafetyPollSequencer` + `runCastSafetyPoll` (DOM-free) against that race,
 * mirroring `player-display-load.unit.spec.ts`'s deferred-promise technique for
 * the main projection load's generation + abort gate.
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
  /**
   * The exact P1 finding: "a pre-hold request returning false can resolve
   * after a newer post-hold request returned true". The fetcher here
   * deliberately does NOT consult `signal` — some transports/mocks resolve a
   * buffered response regardless of abort — so this proves the monotonic
   * generation check, not just cancellation, is what blocks the stale value.
   */
  test('the P1 case: a stale pre-hold false resolving after a fresh post-hold true does not win', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const stalePoll = deferred<CastSafetyState>();
    let calls = 0;

    const fetchSafety: CastSafetyFetcher = async () => {
      calls += 1;
      // Poll tick 1 (pre-hold): outruns the interval, resolves late.
      if (calls === 1) return stalePoll.promise;
      // Poll tick 2 (post-hold): resolves promptly, first.
      return { active: true };
    };

    const stale = runCastSafetyPoll(sequencer, fetchSafety);
    const fresh = runCastSafetyPoll(sequencer, fetchSafety);

    const freshResult = await fresh;
    expect(freshResult).toMatchObject({ kind: 'ok', active: true });

    // Late stale response (pre-hold, inactive) resolves AFTER the fresh
    // post-hold response already raised the curtain — must not be able to
    // clear it. The generation bumped by fresh's begin() means stale is no
    // longer current by the time its data arrives.
    stalePoll.resolve({ active: false });
    const staleResult = await stale;
    expect(staleResult.kind).toBe('ignored');
    if (staleResult.kind === 'ignored') expect(staleResult.reason).toBe('superseded');

    // Caller contract: only 'ok' results are ever applied to castSafetyActive,
    // so simulating the page's reducer here proves the curtain stays raised.
    let castSafetyActive = false;
    for (const result of [freshResult, staleResult]) {
      if (result.kind === 'ok') castSafetyActive = result.active;
    }
    expect(castSafetyActive).toBe(true);
  });

  test('abort: a superseded request whose fetch honors the signal is classified as ignored/aborted', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const stalePoll = deferred<CastSafetyState>();
    const freshPoll = deferred<CastSafetyState>();
    let calls = 0;

    const fetchSafety: CastSafetyFetcher = (signal) => {
      calls += 1;
      return trackAbort(signal, calls === 1 ? stalePoll.promise : freshPoll.promise);
    };

    const stale = runCastSafetyPoll(sequencer, fetchSafety);
    const fresh = runCastSafetyPoll(sequencer, fetchSafety); // begin() aborts stale's signal

    freshPoll.resolve({ active: true });
    const freshResult = await fresh;
    expect(freshResult).toMatchObject({ kind: 'ok', active: true });

    stalePoll.resolve({ active: false }); // underlying deferred settles; trackAbort already rejected
    const staleResult = await stale;
    expect(staleResult.kind).toBe('ignored');
    if (staleResult.kind === 'ignored') expect(staleResult.reason).toBe('aborted');
  });

  test('a genuine failure on the still-current request fails safe (does not clear the curtain)', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const fetchSafety: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    const result = await runCastSafetyPoll(sequencer, fetchSafety);
    expect(result.kind).toBe('failed');
    // The caller (loadCastSafety) only calls setCastSafetyActive on 'ok' — a
    // 'failed' result carries no value, so it can never strand an unsafe false.
  });

  test('a failure on a superseded (already-aborted) request classifies as ignored, not failed', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const hung = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const inFlight = runCastSafetyPoll(sequencer, fetchSafety);
    // A new tick supersedes and aborts the in-flight poll.
    sequencer.begin();
    hung.reject(new DOMException('Aborted', 'AbortError'));
    const result = await inFlight;
    expect(result.kind).toBe('ignored');
    if (result.kind === 'ignored') expect(result.reason).toBe('aborted');
  });

  test('successful in-order polls commit active state changes both ways', async () => {
    const sequencer = new CastSafetyPollSequencer();
    let active = false;
    const fetchSafety: CastSafetyFetcher = async () => ({ active });

    active = true;
    const raised = await runCastSafetyPoll(sequencer, fetchSafety);
    expect(raised).toMatchObject({ kind: 'ok', active: true });

    active = false;
    const released = await runCastSafetyPoll(sequencer, fetchSafety);
    expect(released).toMatchObject({ kind: 'ok', active: false });
  });

  test('invalidate() aborts an in-flight poll and bumps the generation', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const hung = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const inFlight = runCastSafetyPoll(sequencer, fetchSafety);
    sequencer.invalidate(); // unmount / cast token change
    hung.resolve({ active: false });
    const result = await inFlight;
    expect(result.kind).toBe('ignored');

    // A subsequent poll after invalidate still works (fresh generation).
    const after = await runCastSafetyPoll(sequencer, async () => ({ active: true }));
    expect(after).toMatchObject({ kind: 'ok', active: true });
  });

  test('begin() aborts the prior signal so only the latest request is current', () => {
    const sequencer = new CastSafetyPollSequencer();
    const first = sequencer.begin();
    expect(first.signal.aborted).toBe(false);
    expect(sequencer.isCurrent(first.generation)).toBe(true);

    const second = sequencer.begin();
    expect(first.signal.aborted).toBe(true);
    expect(sequencer.isCurrent(first.generation)).toBe(false);
    expect(sequencer.isCurrent(second.generation)).toBe(true);
  });
});
