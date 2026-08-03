/**
 * Issue #1908 rework — cast-token X-Card safety poll sequencing.
 *
 * `GET /cast/:token/safety` is polled on a fixed interval. Five review
 * findings on the same code, each closing one failure mode and (because
 * earlier shapes coupled "when the next tick may run" to "when this one
 * finishes") opening another:
 *
 *  1. Overlapping polls can complete out of order — a slow pre-hold `false`
 *     resolving after a fresh post-hold `true` must not clear the curtain.
 *  2. Aborting whichever poll is in flight on every tick closes (1) but
 *     starves under sustained latency: every tick cancels the last before it
 *     can complete, and the display can sit at its initial state forever.
 *  3. Never overlapping (skip a tick while one is in flight) closes (2) but
 *     reopens starvation narrower: with no deadline, one stalled request
 *     latches the gate forever, disabling every later tick.
 *  4. A deadline that releases the gate closes (3), but the wrong *value*
 *     (tight against the poll interval) aborts every normally-slow-but-
 *     healthy response too, so the poll can never resolve `ok` at all.
 *     Widening the deadline fixes that, but reopens (3) in bounded form —
 *     coupling "next tick may run" to "this one settled" means a single
 *     hang can still delay observing a freshly-raised hold by up to
 *     whatever the deadline is, in tension with the 15s acceptance bound
 *     no matter how the deadline is tuned.
 *  5. The fix: stop coupling ticking to completion. Every tick starts a
 *     genuinely new request — never skipped, never aborted by a later
 *     tick — so an outstanding request (however slow or hung) can never
 *     block a later one. Ordering is handled separately by a monotonic
 *     generation watermark: a response only applies if it is strictly
 *     newer than the highest generation already applied.
 *
 * These specs pin `CastSafetyPollSequencer` + `runCastSafetyPoll` (DOM-free)
 * against all five, mirroring `player-display-load.unit.spec.ts`'s
 * deferred-promise technique.
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
  test('the P1 race: a stale out-of-order response cannot clear a curtain a fresher one raised', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const stalePoll = deferred<CastSafetyState>();
    let calls = 0;

    // Deliberately does NOT consult `signal` — this fetcher can genuinely
    // "complete" even though nothing ever aborted it, proving the generation
    // watermark (not cancellation) is what blocks the stale value.
    const fetchSafety: CastSafetyFetcher = async () => {
      calls += 1;
      if (calls === 1) return stalePoll.promise; // pre-hold: outruns the interval, resolves late
      return { active: true }; // post-hold: resolves promptly, first
    };

    const stale = runCastSafetyPoll(sequencer, fetchSafety);
    const fresh = runCastSafetyPoll(sequencer, fetchSafety);

    const freshResult = await fresh;
    expect(freshResult).toMatchObject({ kind: 'ok', active: true });

    // Late stale response (pre-hold, inactive) resolves AFTER the fresh
    // post-hold response already raised the curtain — must not win.
    stalePoll.resolve({ active: false });
    const staleResult = await stale;
    expect(staleResult.kind).toBe('stale');

    // Caller contract: only 'ok' results are ever applied, so simulating the
    // page's reducer here proves the curtain stays raised.
    let castSafetyActive = false;
    for (const result of [freshResult, staleResult]) {
      if (result.kind === 'ok') castSafetyActive = result.active;
    }
    expect(castSafetyActive).toBe(true);
  });

  test('regression (round 5): a hung request can never block a later tick from running and applying', async () => {
    // This is the exact failure every prior "serialize/skip" shape reopened
    // in some form: an in-flight request that never settles must not gate
    // whether the NEXT scheduled tick can even start. Ticks fire on a fixed
    // interval regardless of outstanding work — a fresh request always gets
    // to run.
    const sequencer = new CastSafetyPollSequencer();
    const hung = deferred<CastSafetyState>();
    const hungFetch: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const stuck = runCastSafetyPoll(sequencer, hungFetch, { timeoutMs: 10_000 });

    // Several more ticks fire while the first is still outstanding — every
    // one of them must actually run (not be skipped) and may apply.
    for (let i = 0; i < 3; i += 1) {
      const tick = await runCastSafetyPoll(sequencer, async () => ({ active: true }), {
        timeoutMs: 10_000,
      });
      expect(tick).toMatchObject({ kind: 'ok', active: true });
    }

    // The hung request settling later (or never) has no bearing on the
    // display having already observed the active hold promptly.
    hung.resolve({ active: false });
    const stuckResult = await stuck;
    expect(stuckResult.kind).toBe('stale'); // superseded by the newer applied generations
  });

  test('a slow-but-healthy response still lands: no deadline is tight enough to reject it', async () => {
    // Round 4's bug in a different shape: the hygiene timeout must never be
    // what determines whether a normal (if slow) response can apply. A
    // response landing well inside even a short hygiene cap must succeed.
    const sequencer = new CastSafetyPollSequencer();
    const slowButHealthy = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowButHealthy.promise);

    const pending = runCastSafetyPoll(sequencer, fetchSafety, { timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    slowButHealthy.resolve({ active: true });

    const result = await pending;
    expect(result).toMatchObject({ kind: 'ok', active: true });
  });

  test('the hygiene cap is generous — not tuned against the poll interval', () => {
    // A regression guard on the constant's role: since no poll's ability to
    // run depends on this value anymore, there is no reason for it to be
    // tight, and a future accidental narrowing back toward "under one
    // interval" should fail a test, not just cause a production incident.
    expect(CAST_SAFETY_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  test('the hygiene timeout still eventually aborts a truly hung request (resource cleanup)', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const hung = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const result = await runCastSafetyPoll(sequencer, fetchSafety, { timeoutMs: 20 });
    expect(result.kind).toBe('ignored');
  });

  test('a genuine failure fails safe and does not block subsequent polls', async () => {
    const sequencer = new CastSafetyPollSequencer();
    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    const result = await runCastSafetyPoll(sequencer, failing);
    expect(result.kind).toBe('failed');
    // The caller only calls setCastSafetyActive on 'ok' — a 'failed' result
    // carries no value, so it can never strand an unsafe false.

    const next = await runCastSafetyPoll(sequencer, async () => ({ active: true }));
    expect(next).toMatchObject({ kind: 'ok', active: true });
  });

  test("invalidate() aborts outstanding polls, and even a late 'completion' that ignores the abort cannot apply", async () => {
    const sequencer = new CastSafetyPollSequencer();
    const hung = deferred<CastSafetyState>();
    // Deliberately ignores `signal` — some transports/mocks resolve a
    // buffered response regardless of abort — so this proves the watermark,
    // not just cancellation, is the backstop.
    const ignoresAbort: CastSafetyFetcher = async () => hung.promise;

    const inFlight = runCastSafetyPoll(sequencer, ignoresAbort);
    sequencer.invalidate(); // unmount / cast token change

    hung.resolve({ active: true });
    const result = await inFlight;
    expect(result.kind).toBe('stale');
  });

  test('invalidate() does not block future polls — cast mode re-entered works normally', async () => {
    const sequencer = new CastSafetyPollSequencer();
    sequencer.invalidate();

    const after = await runCastSafetyPoll(sequencer, async () => ({ active: true }));
    expect(after).toMatchObject({ kind: 'ok', active: true });
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

  test('begin()/shouldApply()/markApplied(): the generation watermark never regresses', () => {
    const sequencer = new CastSafetyPollSequencer();
    const first = sequencer.begin();
    const second = sequencer.begin();

    expect(sequencer.shouldApply(second.generation)).toBe(true);
    sequencer.markApplied(second.generation);
    expect(sequencer.shouldApply(second.generation)).toBe(false); // already applied, no double-apply
    expect(sequencer.shouldApply(first.generation)).toBe(false); // older than the watermark

    const third = sequencer.begin();
    expect(sequencer.shouldApply(third.generation)).toBe(true); // newer than the watermark
  });

  test('begin() never blocks — every call gets its own generation and controller', () => {
    const sequencer = new CastSafetyPollSequencer();
    const a = sequencer.begin();
    const b = sequencer.begin();
    const c = sequencer.begin();
    expect(new Set([a.generation, b.generation, c.generation]).size).toBe(3);
    expect(a.controller.signal.aborted).toBe(false);
    expect(b.controller.signal.aborted).toBe(false);
    expect(c.controller.signal.aborted).toBe(false);
  });
});
