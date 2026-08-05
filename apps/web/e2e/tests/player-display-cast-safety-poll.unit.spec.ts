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
 * Three more findings landed on THAT redesign itself:
 *
 * 11a. Single-writer closes cross-request ordering, but a single SLOW
 *      request is still a problem: it can observe `active: false` moments
 *      before a hold is raised, yet take close to the full hygiene timeout
 *      to return — and because single-writer means the next request can't
 *      even START until this one concludes, a second unlucky slow response
 *      compounds the delay, well past 15s, with neither one ever hitting
 *      the hygiene abort. Fix: stamp each request with when it was issued;
 *      on conclusion, `active: true` still always applies, but a confirmed
 *      `active: false` (or a failure/timeout) is only trusted if it
 *      concluded within `CAST_SAFETY_OBSERVATION_FRESHNESS_MS` of being
 *      issued — otherwise it resolves `{ kind: 'unknown' }`, and the
 *      caller reverts to the curtain instead of silently keeping stale
 *      state. This bounds worst-case exposure to ONE timeout, not two.
 * 11b. `invalidate()` aborting the controller isn't enough by itself: the
 *      single-writer's own `busy` bookkeeping wasn't freed until the
 *      aborted call's `finally` ran — a microtask later — so a `poll()`
 *      issued synchronously right after `invalidate()` (exactly what the
 *      next React effect body does on an identity change) saw the poller
 *      still "busy" and was skipped, silently delaying the new identity's
 *      first check by up to one poll interval. Fix: `invalidate()` frees
 *      the bookkeeping itself, synchronously; the abandoned call's own
 *      cleanup checks it is still the current owner before touching it.
 * 11c. Round 11a judged a failure/timeout by its OWN duration, same as a
 *      value — wrong specifically for failures: after a successful
 *      `false`, a BURST of individually-fast failures (each well inside
 *      the freshness window on its own) could hold `castSafetyKnown`
 *      confidently "inactive" forever, since no single one of them was
 *      ever slow enough to trip the check. The display's confidence
 *      depended on how FAST the server errored, unrelated to whether its
 *      information was still true. Fix: track `lastConfirmedAt` (the last
 *      successful observation of any value) and judge a failure/timeout by
 *      elapsed time since THAT, not by its own duration — collapsing the
 *      slow-failure and fast-failure-burst paths into one rule.
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
 *  - the deadline value (4): re-derived against round 11a's actual
 *    constraint (`CAST_SAFETY_POLL_TIMEOUT_MS <= 15s` on its own, since a
 *    stale conclusion now reverts to `unknown` immediately rather than
 *    waiting on a subsequent poll) — tested as its own guard;
 *  - a slow-but-healthy response still landing: unaffected, still tested;
 *  - the identity-boundary guard (`shouldApplyCastSafetyResult`): unrelated
 *    to any of this and entirely unchanged — see its own describe block.
 */
import { expect, test } from '@playwright/test';
import type { CastSafetyState } from '@campfire/schema';
import {
  CAST_SAFETY_OBSERVATION_FRESHNESS_MS,
  CAST_SAFETY_POLL_TIMEOUT_MS,
  CastSafetyPoller,
  runCastSafetyPoll,
  shouldApplyCastSafetyResult,
  shouldMarkCastSafetyUnknown,
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

  test('the hygiene timeout is load-bearing for correctness, and alone stays inside the 15s acceptance bound', () => {
    // Unlike the retired generation scheme (where nothing depended on this
    // value for correctness — it was pure resource hygiene), the
    // single-writer model's worst-case observation delay for a freshly
    // raised hold is bounded by `CAST_SAFETY_POLL_TIMEOUT_MS` ALONE (issue
    // #1908's 15s bound): round 11a's freshness check means a stale
    // conclusion reverts to `unknown` (curtain shown) immediately, rather
    // than the exposure compounding across a second poll to confirm it.
    const POLL_INTERVAL_MS = 5_000;
    const ACCEPTANCE_BOUND_MS = 15_000;
    expect(CAST_SAFETY_POLL_TIMEOUT_MS).toBeLessThanOrEqual(ACCEPTANCE_BOUND_MS);
    // And still comfortably larger than the interval itself — round 4's
    // mistake was a deadline so tight it aborted ordinary, healthy-but-not-
    // instant responses.
    expect(CAST_SAFETY_POLL_TIMEOUT_MS).toBeGreaterThan(POLL_INTERVAL_MS);
    // The freshness window must itself stay below the hygiene timeout, or
    // nothing could ever be "too old" before the hygiene abort forces a
    // conclusion anyway, and round 11a's/11c's checks would never fire.
    expect(CAST_SAFETY_OBSERVATION_FRESHNESS_MS).toBeLessThan(CAST_SAFETY_POLL_TIMEOUT_MS);
  });

  test('regression (round 12, Devin): the freshness window has real headroom over the poll interval, not just "greater than"', () => {
    // Both round 11a's and round 11c's checks anchor to a timestamp set at
    // the END of the PREVIOUS poll cycle (this request's own `issuedAt`, or
    // the poller's `lastConfirmedAt`) — so even an instantly-concluding
    // NEXT request is already, at minimum, one full poll interval old by
    // the time it lands. A window merely greater than the interval by a
    // sliver would still let one ordinary miss (not a genuine outage) trip
    // it in practice; this asserts MEANINGFUL headroom, not just the bare
    // inequality.
    const POLL_INTERVAL_MS = 5_000;
    const MIN_HEADROOM_MS = 2_000;
    expect(CAST_SAFETY_OBSERVATION_FRESHNESS_MS).toBeGreaterThanOrEqual(POLL_INTERVAL_MS + MIN_HEADROOM_MS);
  });

  test('regression (round 12, the reviewer-supplied scenario): a single failure landing one poll interval after a confirmation stays a fail-safe no-op', async () => {
    // The exact scenario from the finding: `lastConfirmedAt` is stamped at
    // the PREVIOUS poll's conclusion, and the next tick fires POLL_MS
    // later — so a failure concluding at (roughly) POLL_MS after the
    // confirmation must NOT be treated as "too old", or a single dropped
    // check would blank a shared TV mid-game for no real hold.
    const poller = new CastSafetyPoller();
    const POLL_INTERVAL_MS = 5_000;
    const confirmed = await runCastSafetyPoll(poller, async () => ({ active: false }));
    expect(confirmed).toMatchObject({ kind: 'ok', active: false });

    // Simulate the next scheduled tick, one poll interval later, failing —
    // using the poller's real Date.now()-based clock, scaled down via a
    // small freshnessMs so the test stays fast while preserving the SAME
    // ratio (interval : freshness) the production constants have.
    const scaledInterval = 20;
    const scaledFreshness = Math.round((CAST_SAFETY_OBSERVATION_FRESHNESS_MS / POLL_INTERVAL_MS) * scaledInterval);
    await new Promise((resolve) => setTimeout(resolve, scaledInterval));
    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network blip');
    };
    const result = await runCastSafetyPoll(poller, failing, { freshnessMs: scaledFreshness });
    expect(result.kind).toBe('failed');
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

  test('the hygiene timeout still eventually aborts a truly hung request, and reverts to unknown (round 11a)', async () => {
    // Previously this resolved 'ignored' (a no-op, leaving whatever state
    // was last believed untouched). Since a hygiene-timeout abort by
    // construction took the full `timeoutMs` — well past the freshness
    // window — round 11a requires this to revert confidence instead:
    // 'unknown', not a silent no-op, so the caller shows the curtain rather
    // than trusting a belief this stale.
    const poller = new CastSafetyPoller();
    const hung = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, hung.promise);

    const result = await runCastSafetyPoll(poller, fetchSafety, { timeoutMs: 20, freshnessMs: 5 });
    expect(result).toEqual({ kind: 'unknown' });
    expect(poller.isBusy).toBe(false); // the poller frees up, ready for the next tick
  });

  test('a genuine failure fails safe and does not block subsequent polls', async () => {
    const poller = new CastSafetyPoller();
    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    // A fresh poller has never confirmed anything (`lastConfirmedAt` is
    // `null`), which round 11c treats the same as "expired" — matching the
    // page's own fail-safe starting state. Either way (this or a plain
    // no-op 'failed'), neither kind is ever applied as an active hold.
    const result = await runCastSafetyPoll(poller, failing);
    expect(['unknown', 'failed']).toContain(result.kind);
    // The caller only calls setCastSafetyActive on 'ok' — neither 'unknown'
    // nor 'failed' carries an active value, so this can never strand an
    // unsafe false.

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

  test('regression (round 11a): a false response concluding WITHIN the freshness window still applies confidently', async () => {
    const poller = new CastSafetyPoller();
    const fastFalse = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, fastFalse.promise);

    const pending = runCastSafetyPoll(poller, fetchSafety, { freshnessMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fastFalse.resolve({ active: false });

    const result = await pending;
    expect(result).toMatchObject({ kind: 'ok', active: false });
  });

  test('regression (round 11a): a false response concluding AFTER the freshness window reverts to unknown, not applied', async () => {
    // The core of the P1 finding: a `false` observed just before a hold is
    // raised, but too slow to report back, must not be trusted as still
    // describing the current state.
    const poller = new CastSafetyPoller();
    const slowFalse = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowFalse.promise);

    const pending = runCastSafetyPoll(poller, fetchSafety, { freshnessMs: 20, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    slowFalse.resolve({ active: false });

    const result = await pending;
    expect(result).toEqual({ kind: 'unknown' });
  });

  test('regression (round 11a): a true response ALWAYS applies immediately, regardless of its own age', async () => {
    // Never hide a real hold: staleness only ever downgrades a `false`
    // (or a failure/timeout) to `unknown` — a confirmed `true` is exempt,
    // exactly like every earlier round's true/false asymmetry.
    const poller = new CastSafetyPoller();
    const slowTrue = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowTrue.promise);

    const pending = runCastSafetyPoll(poller, fetchSafety, { freshnessMs: 20, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    slowTrue.resolve({ active: true });

    const result = await pending;
    expect(result).toMatchObject({ kind: 'ok', active: true });
  });

  test('regression (round 11c): a genuine failure arriving soon after a confirmed observation stays a fail-safe no-op', async () => {
    // Judged against `lastConfirmedAt`, not this request's own duration
    // (round 11c) — so this test first establishes a confirmation, unlike
    // the pre-round-11c version which relied on a brand-new poller (whose
    // `lastConfirmedAt` is `null` — itself now treated as "expired", not
    // "not yet applicable"; see the very first poll ever in the "no
    // confirmation yet" test below).
    const poller = new CastSafetyPoller();
    const freshnessMs = 5_000;
    const confirmed = await runCastSafetyPoll(poller, async () => ({ active: false }), { freshnessMs });
    expect(confirmed).toMatchObject({ kind: 'ok', active: false });

    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };
    const result = await runCastSafetyPoll(poller, failing, { freshnessMs });
    expect(result.kind).toBe('failed');
  });

  test('regression (round 11a/11c): a genuine failure that takes too long to conclude also reverts to unknown', async () => {
    const poller = new CastSafetyPoller();
    const slowFailure = deferred<CastSafetyState>();
    const fetchSafety: CastSafetyFetcher = (signal) => trackAbort(signal, slowFailure.promise);

    const pending = runCastSafetyPoll(poller, fetchSafety, { freshnessMs: 20, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    slowFailure.reject(new TypeError('network down'));

    const result = await pending;
    expect(result).toEqual({ kind: 'unknown' });
  });

  test('regression (round 11c): with no confirmation EVER, even a fast failure reverts to unknown, matching the page default', async () => {
    // `lastConfirmedAt === null` (nothing ever confirmed) counts as
    // "expired" too — the page's own fail-safe starting state is already
    // "unknown" (curtain shown), so a fast failure before any success has
    // no different, more-confident state to protect.
    const poller = new CastSafetyPoller();
    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('network down');
    };

    const result = await runCastSafetyPoll(poller, failing, { freshnessMs: 5_000 });
    expect(result).toEqual({ kind: 'unknown' });
  });

  test('regression (P1 round 11c, the reviewer-supplied scenario): a burst of individually-FAST failures still expires confidence once their cumulative gap exceeds the bound', async () => {
    // The exact scenario from the finding: after a successful `false`, if
    // every subsequent request fails QUICKLY (inside freshnessMs on its
    // own), round 11a's per-request-duration check alone would let every
    // single one resolve 'failed' (a no-op) forever — an X-Card raised
    // during a fast-failing outage would never raise the curtain. This
    // must expire exactly as surely as one slow failure does, once the
    // CUMULATIVE gap since the last confirmation crosses the bound.
    const poller = new CastSafetyPoller();
    const freshnessMs = 30;

    const confirmed = await runCastSafetyPoll(poller, async () => ({ active: false }), { freshnessMs });
    expect(confirmed).toMatchObject({ kind: 'ok', active: false });

    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('fast 500');
    };

    let sawUnknown = false;
    for (let i = 0; i < 8; i += 1) {
      // Simulates the poll cadence between individually-fast failures —
      // each `failing()` call itself resolves in well under a millisecond.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await runCastSafetyPoll(poller, failing, { freshnessMs });
      if (result.kind === 'unknown') {
        sawUnknown = true;
        break;
      }
      expect(result.kind).toBe('failed');
    }

    expect(sawUnknown).toBe(true);
  });

  test('regression (round 11c): a fresh, fast false response resets confidence even after a preceding burst of failures', async () => {
    // A successful, fast round trip is fresh evidence as of right now,
    // regardless of how long the PRIOR gap of failures was — it must
    // apply confidently and reset the clock for whatever comes after it,
    // not be penalized by history it has nothing to do with.
    const poller = new CastSafetyPoller();
    const freshnessMs = 30;

    const confirmed = await runCastSafetyPoll(poller, async () => ({ active: false }), { freshnessMs });
    expect(confirmed).toMatchObject({ kind: 'ok', active: false });

    const failing: CastSafetyFetcher = async () => {
      throw new TypeError('fast 500');
    };
    // Burn past the freshness window with failures first.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const staleFailure = await runCastSafetyPoll(poller, failing, { freshnessMs });
    expect(staleFailure).toEqual({ kind: 'unknown' });

    // A fresh, fast success immediately afterward must still apply
    // confidently — the earlier failure's staleness does not linger.
    const freshFalse = await runCastSafetyPoll(poller, async () => ({ active: false }), { freshnessMs });
    expect(freshFalse).toMatchObject({ kind: 'ok', active: false });

    // And a subsequent fast failure, right after THAT fresh confirmation,
    // is back to being a benign no-op.
    const nextFailure = await runCastSafetyPoll(poller, failing, { freshnessMs });
    expect(nextFailure.kind).toBe('failed');
  });

  test('regression (P1, the reviewer-supplied scenario): two consecutive slow responses do not compound exposure past one timeout', async () => {
    // The exact scenario from the review finding: a request observes
    // `active: false` just before a hold is raised but takes nearly the
    // full timeout to return, and a SECOND request is then needed to
    // observe `true` — without round 11a, the fight would stay visible for
    // roughly TWO timeouts. With it, the first slow response reverts to
    // `unknown` (curtain shown) on ITS OWN conclusion, so the second
    // request confirming `true` is a bonus, not a requirement for safety.
    const poller = new CastSafetyPoller();
    const freshnessMs = 30;
    const timeoutMs = 100;

    const firstSlowFalse = deferred<CastSafetyState>();
    const first = runCastSafetyPoll(poller, (signal) => trackAbort(signal, firstSlowFalse.promise), {
      freshnessMs,
      timeoutMs,
    });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs - 10));
    firstSlowFalse.resolve({ active: false }); // stale: the hold was raised while this was in flight
    const firstResult = await first;
    expect(firstResult).toEqual({ kind: 'unknown' }); // curtain shows HERE — not after a second request

    const secondSlowTrue = deferred<CastSafetyState>();
    const second = runCastSafetyPoll(poller, (signal) => trackAbort(signal, secondSlowTrue.promise), {
      freshnessMs,
      timeoutMs,
    });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs - 10));
    secondSlowTrue.resolve({ active: true });
    const secondResult = await second;
    expect(secondResult).toMatchObject({ kind: 'ok', active: true });
  });

  test('regression (round 11b): invalidate() frees the poller synchronously, so an immediate next poll is NOT skipped', async () => {
    // Devin's finding: without this, a `poll()` call made synchronously
    // right after `invalidate()` (exactly what the next React effect body
    // does on a cast-identity change) would see the poller still marked
    // busy — because the abandoned call's own cleanup only runs a
    // microtask later — and be skipped, silently delaying the NEW
    // identity's first check by up to one poll interval for no reason.
    const poller = new CastSafetyPoller();
    const hungForOldIdentity = deferred<CastSafetyState>();
    const oldIdentityFetch: CastSafetyFetcher = (signal) => trackAbort(signal, hungForOldIdentity.promise);

    const abandoned = runCastSafetyPoll(poller, oldIdentityFetch);
    expect(poller.isBusy).toBe(true);

    poller.invalidate(); // e.g. cast-token change to a new campaign
    expect(poller.isBusy).toBe(false); // freed SYNCHRONOUSLY, not after a microtask

    // The new identity's mount-time poll, issued right after invalidate()
    // in the same synchronous flow — must actually run, not be skipped.
    let newIdentityFetchCalled = false;
    const newIdentityResult = await runCastSafetyPoll(poller, async () => {
      newIdentityFetchCalled = true;
      return { active: true };
    });
    expect(newIdentityFetchCalled).toBe(true);
    expect(newIdentityResult).toMatchObject({ kind: 'ok', active: true });

    // The abandoned old-identity request settling later must not clobber
    // the new one's bookkeeping.
    hungForOldIdentity.reject(new DOMException('Aborted', 'AbortError'));
    await abandoned.catch(() => undefined);
    expect(poller.isBusy).toBe(false);
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

  test('non-ok results (ignored/failed/unknown) are never applied via shouldApplyCastSafetyResult, identity aside', () => {
    expect(shouldApplyCastSafetyResult({ kind: 'ignored' }, 'token-a', 'token-a')).toBe(false);
    expect(shouldApplyCastSafetyResult({ kind: 'failed' }, 'token-a', 'token-a')).toBe(false);
    expect(shouldApplyCastSafetyResult({ kind: 'unknown' }, 'token-a', 'token-a')).toBe(false);
  });
});

test.describe('shouldMarkCastSafetyUnknown (#1908 rework, round 11a)', () => {
  // Same identity-boundary shape as shouldApplyCastSafetyResult, for the
  // 'unknown' outcome: a too-old observation for an identity the page has
  // already moved on from must not touch the CURRENT identity's state
  // either — even though the render-time reset already put that identity
  // into "unknown" on its own, making this a no-op in practice.
  test('marks unknown when the captured identity still matches the current one', () => {
    expect(shouldMarkCastSafetyUnknown({ kind: 'unknown' }, 'token-a', 'token-a')).toBe(true);
  });

  test('does not mark unknown when the identity no longer matches', () => {
    expect(shouldMarkCastSafetyUnknown({ kind: 'unknown' }, 'token-a', 'token-b')).toBe(false);
    expect(shouldMarkCastSafetyUnknown({ kind: 'unknown' }, 'token-a', null)).toBe(false);
  });

  test('other kinds are never treated as unknown, identity aside', () => {
    expect(shouldMarkCastSafetyUnknown({ kind: 'ok', active: false }, 'token-a', 'token-a')).toBe(false);
    expect(shouldMarkCastSafetyUnknown({ kind: 'ok', active: true }, 'token-a', 'token-a')).toBe(false);
    expect(shouldMarkCastSafetyUnknown({ kind: 'ignored' }, 'token-a', 'token-a')).toBe(false);
    expect(shouldMarkCastSafetyUnknown({ kind: 'failed' }, 'token-a', 'token-a')).toBe(false);
  });
});
