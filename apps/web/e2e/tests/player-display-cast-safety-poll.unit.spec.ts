/**
 * Issue #1908 rework — cast-token X-Card safety poll sequencing.
 *
 * `GET /cast/:token/safety` is polled on a fixed interval. This module first
 * went through nine rounds of a comparison-based scheme (bump a generation
 * counter per poll, compare generations to decide whether a response may
 * apply), each closing one failure mode and opening another:
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
 *  5. Fix: stop coupling ticking to completion. Every tick starts a
 *     genuinely new request — never skipped, never aborted by a later
 *     tick. Ordering is handled separately by a monotonic generation
 *     watermark that (in this shape) only advances on SUCCESS.
 *  6. That watermark-on-success-only is itself incomplete: a newer poll
 *     failing or aborting (never advancing it) lets an older poll's late
 *     success land after it, clearing the curtain with stale data.
 *  7. Applying that same freshest-settled gate to BOTH `true` and `false`
 *     is itself too strict: a slow poll genuinely confirming an ACTIVE hold
 *     can be discarded as "stale" merely because a later-started poll
 *     happened to fail faster. Fix: only `active: false` is gated on being
 *     freshest-settled; `active: true` always applies.
 *  8. Exempting `active: true` UNCONDITIONALLY reopens a narrower problem:
 *     an identity-abandoned request whose fetcher ignores the abort and
 *     resolves anyway raises the WRONG campaign's curtain. Fix: check
 *     `signal.aborted` before either value branch.
 *  9. Even within the SAME identity, exempting `active: true` from ordinary
 *     staleness is too broad in one case: a slow pre-release poll can still
 *     be outstanding when a strictly newer poll actually applies `active:
 *     false` first (a CONFIRMED release). Fix: a second watermark that
 *     advances only on an applied `false`.
 *
 * And then a FOURTH distinct ordering defect surfaced on the same scheme:
 * `generation` reflects request-START order, not completion/observation
 * order, so a comparison built on generation number can still accept an
 * observation that is actually older than one already applied when HTTP
 * responses are serviced out of start order. That finding was the signal
 * that the whole MODEL — comparing generation numbers at all — was wrong,
 * not that one more comparison was missing after nine rounds of them. See
 * `playerDisplayLoad.ts`'s module doc for the full reasoning.
 *
 * The fix replaces the entire generation/watermark scheme with a
 * single-writer poller (`CastSafetyPoller`): at most one request is ever in
 * flight, so there is no second, differently-ordered response for any
 * observation to be compared against. Out-of-order application becomes
 * structurally impossible rather than merely checked-for — there is no
 * `generation` field left to get the comparison wrong on.
 *
 * Consequently, several of the ORIGINAL rounds' specific scenarios (6, 7, 8,
 * 9 — all about comparing generation numbers against each other) are not
 * merely re-tested here, they are RETIRED: the objects those tests
 * manipulated (`begin()`, `settle()`, `confirmFalse()`, `generation` itself)
 * no longer exist, and the races they guarded against cannot occur in a
 * design with only one request in flight at a time. This file intentionally
 * documents that rather than silently dropping coverage. What DOES carry
 * forward, adapted to the new shape:
 *
 *  - out-of-order application (1): now trivial — a second concurrent call is
 *    skipped outright, never started, so there is nothing to apply out of
 *    order;
 *  - starvation (2)/(3): the single-writer model deliberately reintroduces a
 *    BOUNDED version of this trade (a hung request delays the next tick),
 *    which rounds 1-9 spent their effort trying to avoid entirely. This is
 *    an intentional, reviewed trade-off (see `playerDisplayLoad.ts`), not a
 *    regression, and is tested below as the new model's documented behavior;
 *  - the deadline value (4): re-derived against the single-writer model's
 *    actual constraint (`timeoutMs + one poll interval <= 15s`), not
 *    against "comfortably under the interval" — tested as its own guard;
 *  - a slow-but-healthy response still landing: unaffected, still tested;
 *  - the identity-boundary guard (`shouldApplyCastSafetyResult`): unrelated
 *    to any of this and entirely unchanged — see its own describe block.
 */
import { expect, test } from '@playwright/test';
import type { CastSafetyState } from '@campfire/schema';
import {
  CAST_SAFETY_POLL_TIMEOUT_MS,
  CastSafetyPoller,
  runCastSafetyPoll,
  shouldApplyCastSafetyResult,
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

test.describe('CastSafetyPoller + runCastSafetyPoll (#1908 rework — single-writer model)', () => {
  test('out-of-order application is structurally impossible: a second concurrent call is skipped, not started', async () => {
    // This replaces the original "P1 race" test. Under the old
    // generation-comparison scheme, both calls actually ran and the test
    // proved the LATER one's value won regardless of completion order.
    // Under the single-writer model there is nothing to compare: the
    // second call never starts a request at all.
    const poller = new CastSafetyPoller();
    const first = deferred<CastSafetyState>();
    let fetchCalls = 0;
    const fetchSafety: CastSafetyFetcher = () => {
      fetchCalls += 1;
      return first.promise;
    };

    const inFlight = runCastSafetyPoll(poller, fetchSafety);
    expect(poller.isBusy).toBe(true);

    // A second tick while the first is still outstanding is a no-op — it
    // never calls the fetcher, so there is no second response to ever be
    // "out of order" relative to the first.
    const skipped = await runCastSafetyPoll(poller, fetchSafety);
    expect(skipped).toEqual({ kind: 'ignored' });
    expect(fetchCalls).toBe(1);

    first.resolve({ active: true });
    const result = await inFlight;
    expect(result).toMatchObject({ kind: 'ok', active: true });
    expect(poller.isBusy).toBe(false);
  });

  test('a genuinely raised hold is observed by the very next tick once the poller is free again', async () => {
    const poller = new CastSafetyPoller();

    const noHold = await runCastSafetyPoll(poller, async () => ({ active: false }));
    expect(noHold).toMatchObject({ kind: 'ok', active: false });

    const raised = await runCastSafetyPoll(poller, async () => ({ active: true }));
    expect(raised).toMatchObject({ kind: 'ok', active: true });
  });

  test('an intentional, bounded trade-off: a hung request delays (does not lose) the next observation', async () => {
    // Rounds 1-9 spent nine iterations trying to avoid ANY coupling between
    // "is a request still outstanding" and "can the next tick run". The
    // single-writer redesign deliberately accepts a BOUNDED version of that
    // coupling in exchange for making ordering unrepresentable: while one
    // request is in flight, a new tick is skipped outright rather than
    // started. This is not silent data loss — the outstanding request still
    // settles and its value still applies — it is a bounded delay, capped
    // by `CAST_SAFETY_POLL_TIMEOUT_MS`.
    const poller = new CastSafetyPoller();
    const hung = deferred<CastSafetyState>();
    const hungFetch: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const stuck = runCastSafetyPoll(poller, hungFetch, { timeoutMs: 10_000 });

    // Ticks that fire while the hung request is outstanding are skipped, not
    // queued and not separately started.
    const skippedTick = await runCastSafetyPoll(poller, async () => ({ active: true }), { timeoutMs: 10_000 });
    expect(skippedTick).toEqual({ kind: 'ignored' });

    // Once the hung request finally settles, the poller frees up and the
    // NEXT tick runs and applies normally — nothing was permanently lost.
    hung.resolve({ active: true });
    const stuckResult = await stuck;
    expect(stuckResult).toMatchObject({ kind: 'ok', active: true });

    const nextTick = await runCastSafetyPoll(poller, async () => ({ active: true }), { timeoutMs: 10_000 });
    expect(nextTick).toMatchObject({ kind: 'ok', active: true });
  });

  test('the hygiene timeout is now load-bearing for correctness, and is sized to stay inside the 15s acceptance bound', () => {
    // Unlike the retired generation scheme (where nothing depended on this
    // value for correctness — it was pure resource hygiene), the
    // single-writer model's worst-case observation delay for a freshly
    // raised hold is `timeoutMs` (waiting out a hang) plus up to one more
    // poll interval (5s) for the next tick to fire. That sum must not
    // exceed the feature's 15s acceptance bound (issue #1908).
    const POLL_INTERVAL_MS = 5_000;
    const ACCEPTANCE_BOUND_MS = 15_000;
    expect(CAST_SAFETY_POLL_TIMEOUT_MS + POLL_INTERVAL_MS).toBeLessThanOrEqual(ACCEPTANCE_BOUND_MS);
    // And still comfortably larger than the interval itself — round 4's
    // mistake was a deadline so tight it aborted ordinary, healthy-but-not-
    // instant responses.
    expect(CAST_SAFETY_POLL_TIMEOUT_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });

  test('a slow-but-healthy response still lands: no deadline is tight enough to reject it', async () => {
    const poller = new CastSafetyPoller();
    const slowButHealthy = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowButHealthy.promise);

    const pending = runCastSafetyPoll(poller, fetchSafety, { timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    slowButHealthy.resolve({ active: true });

    const result = await pending;
    expect(result).toMatchObject({ kind: 'ok', active: true });
  });

  test('the hygiene timeout still eventually aborts a truly hung request (resource cleanup)', async () => {
    const poller = new CastSafetyPoller();
    const hung = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const result = await runCastSafetyPoll(poller, fetchSafety, { timeoutMs: 20 });
    expect(result.kind).toBe('ignored');
    expect(poller.isBusy).toBe(false); // the poller frees up, ready for the next tick
  });

  test('a genuine failure fails safe and does not block subsequent polls', async () => {
    const poller = new CastSafetyPoller();
    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    const result = await runCastSafetyPoll(poller, failing);
    expect(result.kind).toBe('failed');
    // The caller only calls setCastSafetyActive on 'ok' — a 'failed' result
    // carries no value, so it can never strand an unsafe false.

    const next = await runCastSafetyPoll(poller, async () => ({ active: true }));
    expect(next).toMatchObject({ kind: 'ok', active: true });
  });

  test("invalidate() aborts an outstanding poll, and even a late 'completion' that ignores the abort cannot clear the curtain", async () => {
    const poller = new CastSafetyPoller();
    const hung = deferred<CastSafetyState>();
    // Deliberately ignores `signal` — some transports/mocks resolve a
    // buffered response regardless of abort — so this proves an explicit
    // abort, not just cancellation, is the backstop.
    const ignoresAbort: CastSafetyFetcher = async () => hung.promise;

    const inFlight = runCastSafetyPoll(poller, ignoresAbort);
    poller.invalidate(); // unmount / cast token change

    hung.resolve({ active: false });
    const result = await inFlight;
    expect(result.kind).toBe('ignored');
    expect(poller.isBusy).toBe(false);
  });

  test('invalidate() rejects a buffered active:true too, not only false', async () => {
    const poller = new CastSafetyPoller();
    const hung = deferred<CastSafetyState>();
    const ignoresAbort: CastSafetyFetcher = async () => hung.promise;

    const inFlight = runCastSafetyPoll(poller, ignoresAbort);
    poller.invalidate(); // cast-token change to a new campaign

    hung.resolve({ active: true }); // campaign A's stale hold, arriving after B has taken over
    const result = await inFlight;
    expect(result.kind).toBe('ignored');
  });

  test('invalidate() does not block future polls — cast mode re-entered works normally', async () => {
    const poller = new CastSafetyPoller();
    poller.invalidate();

    const after = await runCastSafetyPoll(poller, async () => ({ active: true }));
    expect(after).toMatchObject({ kind: 'ok', active: true });
  });

  test('successful in-order polls commit active state changes both ways', async () => {
    const poller = new CastSafetyPoller();
    let active = false;
    const fetchSafety: CastSafetyFetcher = async () => ({ active });

    active = true;
    const raised = await runCastSafetyPoll(poller, fetchSafety);
    expect(raised).toMatchObject({ kind: 'ok', active: true });

    active = false;
    const released = await runCastSafetyPoll(poller, fetchSafety);
    expect(released).toMatchObject({ kind: 'ok', active: false });
  });
});

test.describe('shouldApplyCastSafetyResult (#1908 rework — the identity-boundary P1 finding)', () => {
  // The poller above only orders polls WITHIN one cast identity; it has no
  // notion of the identity itself changing mid-flight. On an SPA transition
  // between two cast tokens, the page's render-time state reset and
  // `poller.invalidate()` (which runs later, in the OLD effect's passive
  // cleanup) are not the same instant — in that gap, the OLD identity's
  // in-flight poll is an entirely ordinary request as far as the poller is
  // concerned, and can legitimately resolve `ok`. This is the commit-site
  // guard that closes that gap: it does not touch the poller at all, it
  // just refuses to apply an otherwise-valid `ok` result whose captured
  // identity no longer matches the page's current one. Unaffected by the
  // single-writer redesign above — this concern is orthogonal to it.
  test('applies an ok result when the captured identity still matches the current one', () => {
    expect(shouldApplyCastSafetyResult({ kind: 'ok', active: true }, 'token-a', 'token-a')).toBe(true);
    expect(shouldApplyCastSafetyResult({ kind: 'ok', active: false }, 'token-a', 'token-a')).toBe(true);
  });

  test('drops an ok result whose captured identity no longer matches — the P1 race', () => {
    // A stale campaign-A response landing after the page has already moved
    // on to campaign B must never set campaign B's state, regardless of
    // whether the value it carries is true or false.
    expect(shouldApplyCastSafetyResult({ kind: 'ok', active: false }, 'token-a', 'token-b')).toBe(false);
    expect(shouldApplyCastSafetyResult({ kind: 'ok', active: true }, 'token-a', 'token-b')).toBe(false);
  });

  test('drops an ok result when the page has moved out of cast mode entirely', () => {
    expect(shouldApplyCastSafetyResult({ kind: 'ok', active: false }, 'token-a', null)).toBe(false);
  });

  test('non-ok results (ignored/failed) are never applied, identity aside', () => {
    expect(shouldApplyCastSafetyResult({ kind: 'ignored' }, 'token-a', 'token-a')).toBe(false);
    expect(shouldApplyCastSafetyResult({ kind: 'failed' }, 'token-a', 'token-a')).toBe(false);
  });
});
