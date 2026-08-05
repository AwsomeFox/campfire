/**
 * Player Display load sequencing (issue #743).
 *
 * Poll + SSE bursts used to fire overlapping multi-request loads with no
 * cancellation or generation guard. An older summary/list/detail trio could
 * finish after a newer one and paint stale combat back onto the TV, and a
 * transient detail failure wiped the initiative rail entirely.
 *
 * This module owns the race-safe contract:
 *   - abort (or ignore) superseded loads via a monotonic generation;
 *   - fetch summary + running list + detail, then commit one consistent
 *     projection;
 *   - re-verify the encounter is still running before painting it live;
 *   - on transient failure, keep last-known state and flag stale;
 *   - on persistent failure after summary succeeded, keep the cast and drop
 *     only the initiative rail (rail-scoped error — not a full-screen wipe).
 *
 * Extracted so the e2e unit suite can drive every reorder / End-during-load /
 * campaign-change scenario without mounting React.
 */
import type { CampaignSummary, CastSafetyState, Encounter, EncounterWithCombatants } from '@campfire/schema';
import { ApiError, isTransientError } from '../../lib/api';

/** One consistent Player Display paint — summary and encounter from the same load. */
export type PlayerDisplayProjection = {
  campaignId: number;
  summary: CampaignSummary;
  encounter: EncounterWithCombatants | null;
};

export type PlayerDisplayFetchers = {
  getSummary: (campaignId: number, signal: AbortSignal) => Promise<CampaignSummary>;
  getRunningEncounters: (campaignId: number, signal: AbortSignal) => Promise<Encounter[]>;
  getEncounter: (encounterId: number, signal: AbortSignal) => Promise<EncounterWithCombatants>;
};

export type PlayerDisplayLoadOk = {
  kind: 'ok';
  generation: number;
  projection: PlayerDisplayProjection;
};

export type PlayerDisplayLoadIgnored = {
  kind: 'ignored';
  generation: number;
  reason: 'aborted' | 'superseded' | 'campaign-changed';
};

export type PlayerDisplayLoadFailed = {
  kind: 'failed';
  generation: number;
  message: string;
  /** True when the caller should keep last-known projection and show stale UI. */
  keepLastKnown: boolean;
  transient: boolean;
  /**
   * Summary fetched before a later step failed. When present, the caller should
   * keep the cast summary and drop only the initiative rail (not full-screen wipe).
   */
  summary: CampaignSummary | null;
};

export type PlayerDisplayLoadResult =
  | PlayerDisplayLoadOk
  | PlayerDisplayLoadIgnored
  | PlayerDisplayLoadFailed;

/** Live / stale / offline chip for the cast surface (mirrors dashboard schedule sync). */
export type PlayerDisplaySyncState = 'live' | 'stale' | 'offline' | 'reconnecting';

export function playerDisplaySyncState(input: {
  staleIdentity: boolean;
  displayStale: boolean;
  eventStatus: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'stopped';
}): PlayerDisplaySyncState {
  // Match dashboard schedule sync: initial `connecting` is not a stale warning —
  // only dropped/offline streams and failed refreshes should keep last-known UI.
  if (input.staleIdentity || input.eventStatus === 'offline') return 'offline';
  if (input.eventStatus === 'reconnecting') return 'reconnecting';
  if (input.displayStale || input.eventStatus === 'stopped') return 'stale';
  return 'live';
}

export function playerDisplaySyncMessage(state: PlayerDisplaySyncState): string | null {
  switch (state) {
    case 'offline':
      return 'Offline — showing last-known display.';
    case 'reconnecting':
      return 'Reconnecting — showing last-known display.';
    case 'stale':
      return 'Live updates interrupted — showing last-known display.';
    default:
      return null;
  }
}

function isAbortError(error: unknown): boolean {
  // Only real aborts — not TimeoutError. A timeout that did not abort our
  // signal must reach the transient failure path so callers can clear loading
  // / keepLastKnown. If a timeout aborts via AbortController, `signal.aborted`
  // in the catch path already covers it.
  if (!error || typeof error !== 'object') return false;
  return (error as { name?: unknown }).name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * Abort-aware multi-request fetch that resolves to one consistent projection.
 * Does not touch React state — the sequencer decides whether to commit.
 */
export async function fetchPlayerDisplayProjection(
  campaignId: number,
  fetchers: PlayerDisplayFetchers,
  signal: AbortSignal,
): Promise<PlayerDisplayProjection> {
  const summary = await fetchers.getSummary(campaignId, signal);
  throwIfAborted(signal);

  const running = await fetchers.getRunningEncounters(campaignId, signal);
  throwIfAborted(signal);

  const live = running[0];
  if (!live) {
    return { campaignId, summary, encounter: null };
  }

  const detail = await fetchers.getEncounter(live.id, signal);
  throwIfAborted(signal);

  // End-during-load: a detail body can still arrive after the DM ends combat.
  // Only paint the initiative rail when the encounter is still running AND still
  // present in the running list (re-check closes the list→detail gap).
  if (detail.status !== 'running') {
    return { campaignId, summary, encounter: null };
  }

  const stillRunning = await fetchers.getRunningEncounters(campaignId, signal);
  throwIfAborted(signal);
  if (!stillRunning.some((encounter) => encounter.id === detail.id && encounter.status === 'running')) {
    return { campaignId, summary, encounter: null };
  }

  return { campaignId, summary, encounter: detail };
}

/**
 * Monotonic generation + AbortController gate for Player Display loads.
 * Every `begin()` aborts the prior in-flight load; only the latest generation
 * may commit.
 */
export class PlayerDisplayLoadSequencer {
  private generation = 0;
  private controller: AbortController | null = null;
  private activeCampaignId: number | null = null;

  /** Current generation (0 before the first begin). */
  get currentGeneration(): number {
    return this.generation;
  }

  get activeCampaign(): number | null {
    return this.activeCampaignId;
  }

  /**
   * Start a new load for `campaignId`. Aborts any prior in-flight load and
   * bumps the generation so late responses from the old load are ignored.
   */
  begin(campaignId: number): { generation: number; signal: AbortSignal } {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.generation += 1;
    this.activeCampaignId = campaignId;
    return { generation: this.generation, signal: controller.signal };
  }

  /** True when this generation is still the active load for `campaignId`. */
  isCurrent(generation: number, campaignId: number): boolean {
    return (
      generation === this.generation
      && this.activeCampaignId === campaignId
      && this.controller != null
      && !this.controller.signal.aborted
    );
  }

  /**
   * Abort in-flight work and bump the generation so late responses cannot
   * commit. Call once per teardown transition (React effect cleanup) — do not
   * also call from the next effect body on campaign change, or the generation
   * double-bumps.
   */
  invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
    this.activeCampaignId = null;
  }
}

/**
 * Cast-token X-Card safety poll sequencing (issue #1908 rework).
 *
 * The safety poll is a single anonymous `GET /cast/:token/safety` on the same
 * visible-tab cadence as the rest of this page. This mechanism first went
 * through nine rounds of a comparison-based scheme — bump a generation
 * counter per poll, compare generations to decide whether a response may
 * apply — each round closing one failure mode and opening another:
 *
 *  1. Abort whichever poll was in flight on every new tick, apply whatever
 *     comes back: an out-of-order stale response can resolve after a fresher
 *     one and clear the curtain while the X-Card is still raised.
 *  2. Fix (1) by aborting on every tick + a generation guard: closes the
 *     race, but under sustained latency (every response ≥ the interval)
 *     every tick cancels the last before it can ever complete — the display
 *     can sit at its initial state forever even with an active hold.
 *  3. Fix (2) by never overlapping — skip a tick while one is in flight
 *     instead of aborting it: closes the abort-starvation mode, but with no
 *     deadline a single stalled (hung, never-settling) request leaves the
 *     gate latched forever, silently disabling every later tick.
 *  4. Fix (3) with a deadline that releases the gate: the *value* chosen
 *     (4s, "comfortably under the 5s interval") was itself wrong — an
 *     endpoint healthily responding in 4–5s would have every request
 *     aborted before completion, so the poll could never resolve `ok` at
 *     all.
 *  5. Fix (4) by decoupling ticking from completion (every tick starts a
 *     genuinely new, never-aborted request), gated only by a generation
 *     watermark that advances on SUCCESS: a poll succeeding is not the only
 *     way it can conclude, so a newer poll that fails or aborts (never
 *     advancing a success-only watermark) lets an OLDER poll's late success
 *     land after it, clearing the curtain with out-of-date data.
 *  6. Fix (5) by advancing the watermark on every conclusion regardless of
 *     outcome: applying that SAME gate uniformly to both `true` and `false`
 *     lets a newer poll merely failing FASTER discard an older but genuinely
 *     confirmed `true` as "stale" — the curtain can then stay down
 *     indefinitely despite a real, repeatedly-confirmed hold.
 *  7. Fix (6) by exempting `active: true` from the freshest-settled gate
 *     entirely: but the exemption was unconditional, so a request explicitly
 *     abandoned by `invalidate()` (identity change) whose fetcher ignores
 *     the abort and resolves anyway raises the WRONG campaign's curtain.
 *  8. Fix (7) by checking the request's own abort signal before either
 *     value branch — closes the identity-abandonment case specifically.
 *  9. Even within the SAME identity, unconditionally exempting `active:
 *     true` is still too broad: a slow pre-release poll can still be
 *     outstanding when a strictly newer poll actually applies a confirmed
 *     `active: false` first, and the older `true` landing afterward
 *     re-raises a curtain over a game newer evidence already confirmed
 *     resumed. Fix: a second watermark, advanced only on an applied
 *     `false`, distinct from a newer poll merely failing (6)'s mistake.
 * 10. And then a FOURTH distinct ordering defect surfaced on this same
 *     scheme: `generation` is assigned at REQUEST-START order, but HTTP
 *     responses can be serviced out of start order. Generation 1 (older
 *     start) can be the one that actually reflects the more recent server
 *     state if generation 2's response — despite starting later — reaches
 *     the server and returns *first*, before the hold in generation 1's
 *     window even changes. No comparison built on "which generation started
 *     first" can be correct here, because generation number was never a
 *     proxy for observation time to begin with — it only ever recorded
 *     request-issue order, and (1) through (9) all, in different ways,
 *     conflated the two.
 *
 * That last finding is not "one more patch": the whole class of defect —
 * four distinct ordering bugs across nine rounds, each locally correct and
 * each revealing the next seam — says the comparison-based MODEL is wrong,
 * not that one more comparison was missing. `generation`, `settledGeneration`,
 * and `confirmedFalseGeneration` are gone. In their place:
 *
 * **Single-writer poll.** `CastSafetyPoller` allows at most one request in
 * flight at a time. A `poll()` call while one is already outstanding is a
 * no-op (`{ kind: 'ignored' }`) rather than a second concurrent request to
 * reconcile against later. Because only one request can ever be in flight,
 * there is no second, differently-ordered response for any observation to
 * be compared against — whichever response arrives IS unconditionally the
 * most recent observation, every time, by construction rather than by
 * checking. Ordering is not RESOLVED here; it is UNREPRESENTABLE: the type
 * that would carry two outstanding requests' generations to compare against
 * each other simply does not exist in this design.
 *
 * 11a. Single-writer closes the CROSS-request ordering problem, but a
 *      single SLOW request is still a problem on its own: if a request
 *      observes `active: false` moments before a hold is raised, but takes
 *      close to the full hygiene timeout to return, applying that `false`
 *      at the (late) time it finally arrives asserts "no hold" about a
 *      moment that, by then, is stale — and because single-writer means
 *      the NEXT request cannot even start until this one concludes, a
 *      second unlucky slow response compounds the delay further, well
 *      past the 15s acceptance bound, with neither request ever hitting
 *      the hygiene abort. Fix: stamp every request with when it was
 *      ISSUED. On conclusion, a confirmed `active: true` still applies
 *      unconditionally (never hide a real hold), but a confirmed
 *      `active: false` — or a failure/timeout — is only trusted as a
 *      confident "currently safe" observation if it concluded within
 *      `CAST_SAFETY_OBSERVATION_FRESHNESS_MS` of being issued. Older than
 *      that, the observation tells us nothing about the CURRENT state, so
 *      the result is `{ kind: 'unknown' }`: the caller must revert to the
 *      same fail-safe "not confirmed" state the page starts in (show the
 *      curtain), not silently keep whatever it last believed. This bounds
 *      worst-case exposure to a single `CAST_SAFETY_POLL_TIMEOUT_MS` (the
 *      longest any one conclusion — value, failure, or hygiene-abort — can
 *      take), not two, because the FIRST unlucky slow conclusion already
 *      reverts to "unknown" (curtain shown) instead of waiting for a
 *      second request's `true` to confirm it.
 * 11b. `invalidate()` aborting the in-flight controller is not enough on
 *      its own: it doesn't free the single-writer's own "busy" bookkeeping
 *      until the aborted call's `finally` runs, which — because the abort
 *      only rejects the awaited fetch as a microtask — happens strictly
 *      AFTER a `poll()` call made synchronously right after `invalidate()`
 *      (exactly what the next React effect body does on an identity
 *      change). That ordering silently skips the new identity's very
 *      first check as "busy", delaying it to the next scheduled tick (up
 *      to one poll interval later) for no reason — the old request was
 *      already abandoned. Fix: `invalidate()` clears the single-writer
 *      bookkeeping ITSELF, synchronously, rather than leaving it to the
 *      abandoned call's own cleanup; that cleanup checks it is still the
 *      current owner before touching shared state, so it can never
 *      clobber a NEWER call's bookkeeping if one has already started.
 * 11c. Round 11a's freshness check judged a FAILURE/timeout conclusion by
 *      its OWN duration (issue to conclusion) — the same yardstick used for
 *      a value. That is wrong for a failure specifically: after a
 *      successful `false`, if every SUBSEQUENT request fails quickly
 *      (each individually well inside the freshness window), every one of
 *      them passed its own-duration check and stayed `failed` (a no-op) —
 *      so a fast-failing outage could hold `castSafetyKnown` confidently
 *      "inactive" indefinitely, even with a hold raised and un-observed
 *      the entire time, no single request ever slow enough to trip
 *      anything. The display's confidence depended on how FAST the server
 *      errored, unrelated to whether its last known information was still
 *      true. Fix: track `lastConfirmedAt`, the timestamp of the last
 *      successful observation of ANY value (true or false); judge a
 *      FAILURE/timeout conclusion by elapsed time since THAT, not by its
 *      own duration. A burst of individually-fast failures now expires
 *      confidence exactly as surely as one slow one, once their cumulative
 *      gap since the last confirmation exceeds the window — collapsing the
 *      slow-failure and fast-failure-burst paths into the same rule. (A
 *      value response's OWN round-trip freshness check is unaffected and
 *      still needed — see the note on that branch in `poll()` for why it
 *      is not simply replaced by the same `lastConfirmedAt` comparison.)
 * 12.  `CAST_SAFETY_OBSERVATION_FRESHNESS_MS` (5s) was exactly equal to the
 *      page's poll interval — both round 11a's and round 11c's checks
 *      anchor to a timestamp set at the END of the PREVIOUS poll cycle, so
 *      even an instantly-concluding next request is already, at minimum,
 *      one full interval old by the time it lands. A window equal to (not
 *      meaningfully larger than) that interval meant one ordinary
 *      slow/failed response — not a genuine multi-tick outage — routinely
 *      crossed it, flashing the curtain over a live shared TV for no real
 *      reason. Fix: widen to 8s, giving real headroom above the 5s
 *      interval while staying comfortably below `CAST_SAFETY_POLL_TIMEOUT_MS`
 *      (10s) — see that constant's own doc for the exact derivation and
 *      the worst-case bound this still satisfies.
 * 13a. Widening round 12's window reopened a DIFFERENT exposure round 11a
 *      thought it had closed: single-writer's "a tick arriving while busy
 *      is simply skipped" meant that a hold raised WHILE a slow request was
 *      in flight had to wait not only for that request to conclude, but
 *      for the NEXT externally-scheduled tick (`usePollWhileVisible`'s
 *      fixed interval) to fire before a fresh request could even START —
 *      up to one more full poll interval, on top of whatever the widened
 *      window already tolerated. Treating a raised hold (`true`) and an
 *      inactive read (`false`) symmetrically under one "freshness window"
 *      number was the wrong shape: `true` must never be delayed by ANY of
 *      this, at any window size. Fix: stop treating a skipped tick as
 *      discarded. `poll()` now COALESCES a call that arrives while busy
 *      onto a pending follow-up, and the moment the in-flight request
 *      concludes, that follow-up fires IMMEDIATELY — not gated by the next
 *      scheduled tick — so a hold raised during the busy window is observed
 *      as soon as the poller is next free, never later. This is still
 *      single-writer (at most one HTTP request in flight at any instant —
 *      the follow-up only starts once the prior one has fully concluded),
 *      so out-of-order application remains structurally impossible; only
 *      the SCHEDULING of the next attempt changed, from timer-driven to
 *      event-driven. Multiple calls arriving during the same busy window
 *      coalesce onto ONE follow-up (the freshest arrival's `fetchSafety`/
 *      `options` win), since it reflects the freshest achievable state
 *      regardless of how many ticks were coalesced into it.
 * 13b. `Date.now()` is wall-clock time: NTP correction or a device
 *      resuming from sleep (exactly this feature's deployment target — a
 *      wall-mounted shared-TV display) can make it jump BACKWARD. Every
 *      elapsed-time comparison in this module (`issuedAt`/`concludedAt`
 *      round-trip age, `lastConfirmedAt` staleness) used it, so a backward
 *      jump during an aged observation could make a stale `false`, or a
 *      run of failures, compute a negative or understated elapsed time —
 *      looking artificially FRESH regardless of how long it has actually
 *      been, silently defeating rounds 11a/11c's whole protection. Fix:
 *      `performance.now()` for all of it — monotonic, immune to wall-clock
 *      adjustments, exactly the class of source `Date.now()`'s docs
 *      themselves warn against using for measuring elapsed duration.
 *
 * The trade round 11a accepts, explicitly: a hung request now DOES delay
 * the next observation (rounds 1-3's exact tension), bounded by
 * `CAST_SAFETY_POLL_TIMEOUT_MS` rather than the sequencing being free of it.
 * That constant is therefore back to being load-bearing for correctness —
 * unlike the generation scheme's version, which (rounds 4-9) explicitly
 * carried none. Combined with round 11a's freshness check (round 11c's
 * extension of it to failures, and round 13a's immediate-catch-up on a
 * coalesced follow-up), the worst-case exposure from hold-raised to
 * curtain-shown stays within the feature's 15s acceptance bound: a
 * `true` observation is NEVER gated on freshness and is now also never
 * delayed by a skipped tick waiting on the next scheduled interval, so its
 * only remaining bound is `CAST_SAFETY_POLL_TIMEOUT_MS` (10s) — the
 * longest a single in-flight request (whichever one happens to be running
 * when the hold is raised) can take to conclude before the poller is free
 * to observe it. A `false`/failure path staying wrongly "confident" is
 * separately bounded by round 12's widened freshness window (~10s worst
 * case for a fast-failure burst, given the current tuning) — see that
 * constant's own doc for the exact reasoning.
 *
 * Cancellation on an identity change (unmount / cast-token change) is just
 * "abort the one possible in-flight request, free the poller, and drop
 * (resolving as `ignored`) any coalesced follow-up that hadn't started yet"
 * (`invalidate()`) — no generation bump, no watermark to fast-forward,
 * because there is only ever one thing to cancel. The identity-BOUNDARY
 * guard (`shouldApplyCastSafetyResult`/`shouldMarkCastSafetyUnknown`,
 * below) is unrelated to any of this and is unchanged by this redesign: it
 * protects the react-state commit site against an old identity's in-flight
 * request resolving after a NEWER identity's render has already committed,
 * which is a component-level concern the poller (whichever shape it takes)
 * cannot see or fix.
 */
export type CastSafetyFetcher = (signal: AbortSignal) => Promise<CastSafetyState>;

/**
 * Bounds one safety poll request's lifetime. The single-writer poller
 * COUPLES "how long can a single conclusion — value, failure, or
 * hygiene-abort — delay a confident observation" to this value, so it is
 * chosen, not just generous: with round 11a's freshness check in place,
 * the worst-case exposure from a hold being raised to the curtain showing
 * is bounded by THIS value alone (a stale/failed/timed-out conclusion
 * reverts to `unknown` — curtain shown — immediately, rather than waiting
 * for a subsequent poll to confirm it), so it only needs to stay at or
 * under the feature's 15s acceptance bound (issue #1908) on its own. 10s
 * leaves a full 5s of margin under that ceiling while still being
 * comfortably larger than the 5s poll interval itself (avoiding round 4's
 * mistake of a deadline so tight it aborts ordinary, healthy-but-not-
 * instant responses).
 */
export const CAST_SAFETY_POLL_TIMEOUT_MS = 10_000;

/**
 * How old (issue-to-conclusion) an `active: false` observation may be and
 * still be trusted as describing the CURRENT state (round 11a); and,
 * separately, how long since the last successful confirmation of ANY value
 * a failure/hygiene-abort may be before it also stops being trusted as a
 * benign no-op (round 11c).
 *
 * Round 12 (Devin): this must have REAL headroom over the page's poll
 * interval (`POLL_MS`, 5s — see `PlayerDisplayPage.tsx`), not merely be
 * larger than a single request's own near-instant round trip. Both
 * mechanisms above are anchored to a PRIOR timestamp (this request's own
 * `issuedAt`, or the poller's `lastConfirmedAt`) that was itself set at the
 * END of the previous poll cycle — so even an infinitely-fast NEXT
 * conclusion is already, at minimum, one full poll interval old the moment
 * it lands. A value equal to (or barely above) that interval means a
 * single ordinary missed/slow response — not a genuine multi-tick outage —
 * routinely crosses the threshold and flips a live shared TV to the
 * curtain for no real reason. 8s gives a full 3s of headroom above the 5s
 * interval (enough to absorb one poll's own ordinary latency without
 * tripping on a single miss), while staying comfortably below
 * `CAST_SAFETY_POLL_TIMEOUT_MS` (10s) — otherwise nothing could ever be
 * "too old" before the hygiene abort forces a conclusion anyway, and this
 * check would never fire at all. See the unit suite's guard test for the
 * exact `POLL_INTERVAL_MS < freshnessMs < CAST_SAFETY_POLL_TIMEOUT_MS`
 * relationship this is required to satisfy.
 */
export const CAST_SAFETY_OBSERVATION_FRESHNESS_MS = 8_000;

export type CastSafetyPollResult =
  | { kind: 'ok'; active: boolean }
  /**
   * A conclusion arrived that is too old to trust as still describing the
   * CURRENT state — either a confirmed `active: false` whose OWN round
   * trip exceeded `CAST_SAFETY_OBSERVATION_FRESHNESS_MS` (round 11a), or a
   * failure/hygiene-timeout that arrived more than that long after the
   * last successful confirmation of any value (round 11c). The caller must
   * revert to the same "not yet confirmed" fail-safe state the page starts
   * in (show the curtain), not silently keep whatever it last believed.
   */
  | { kind: 'unknown' }
  /** Skipped outright (a poll was already in flight — single-writer), or
   * an in-flight request explicitly abandoned by `invalidate()` (unmount /
   * identity change). Either way: no information gained here, so the
   * caller does nothing — the identity-change case already has its own
   * reset (see `PlayerDisplayPage.tsx`'s doc). */
  | { kind: 'ignored' }
  /** A genuine (non-abort) failure arriving while the LAST successful
   * confirmation (of any value) is still within the freshness window —
   * recent enough that this failure alone doesn't demand reverting
   * confidence; the caller fails safe by leaving the last-known hold state
   * untouched rather than guessing a new value. Once enough elapsed time
   * has passed since that last confirmation — whether from one slow
   * failure or a burst of fast ones — this becomes `unknown` instead
   * (round 11c). */
  | { kind: 'failed' };

/** Internal marker distinguishing an `invalidate()`-triggered abort (drop
 * the result outright, regardless of value — round 8) from the hygiene
 * timeout's abort (route through the normal age-gated logic — round 11a:
 * by construction it took the full `timeoutMs`, so a `false` value almost
 * always resolves `unknown`, while a `true` value still applies). */
const INVALIDATE_ABORT_REASON = 'campfire/cast-safety-poller-invalidated';

/**
 * Single-writer cast-safety poller. At most one request is ever in flight;
 * see the module doc above for why this makes cross-request out-of-order
 * application structurally impossible rather than merely checked-for, and
 * for the (separate) issue-time freshness check that bounds a single slow
 * request's own exposure.
 */
type CastSafetyPollOptions = { timeoutMs?: number; freshnessMs?: number };

export class CastSafetyPoller {
  private controller: AbortController | null = null;
  private busy = false;
  /**
   * When the last successful observation (of ANY value, true or false) was
   * confirmed. `null` means never — the fail-safe starting state. Round
   * 11c: this is what a FAILURE/timeout conclusion is judged against, not
   * its own individual duration — see that round's note on `executeOnce`
   * below. Stamped with `performance.now()` (round 13b), not `Date.now()`
   * — see the module doc's round 13b entry for why that distinction is
   * load-bearing on THIS feature's deployment target.
   */
  private lastConfirmedAt: number | null = null;
  /**
   * Set when a `poll()` call arrives while `busy`. Holds the fetcher/
   * options to run as an IMMEDIATE follow-up the instant the in-flight
   * request concludes (round 13a), plus every caller's resolver waiting on
   * that follow-up's real result. Multiple arrivals during the same busy
   * window coalesce onto this ONE pending follow-up — the latest arrival's
   * `fetchSafety`/`options` win, since only the freshest achievable check
   * matters, but every coalesced caller's resolver is kept and all are
   * notified together once it runs.
   */
  private followUp: {
    fetchSafety: CastSafetyFetcher;
    options: CastSafetyPollOptions;
    resolvers: Array<(result: CastSafetyPollResult) => void>;
  } | null = null;

  /** True while a request is in flight. Exposed for tests/observability —
   * `poll()` already consults this itself. */
  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * Run one poll tick. If a previous call on this instance is still in
   * flight, this call does NOT start a second concurrent request — single-
   * writer still holds, so out-of-order application stays structurally
   * impossible — but it is no longer simply discarded either (round 13a):
   * it coalesces onto a pending follow-up that fires the INSTANT the
   * in-flight request concludes, rather than waiting for the next
   * externally-scheduled tick. A hold raised while a request happens to be
   * in flight is therefore observed as soon as the poller is next free,
   * not up to one more poll interval later on top of that.
   */
  async poll(fetchSafety: CastSafetyFetcher, options: CastSafetyPollOptions = {}): Promise<CastSafetyPollResult> {
    if (this.busy) {
      return new Promise<CastSafetyPollResult>((resolve) => {
        if (this.followUp) {
          // A later arrival supersedes an earlier one's fetcher/options —
          // only the freshest coalesced request actually needs to run —
          // but every arrival's resolver still gets notified from it.
          this.followUp.fetchSafety = fetchSafety;
          this.followUp.options = options;
          this.followUp.resolvers.push(resolve);
        } else {
          this.followUp = { fetchSafety, options, resolvers: [resolve] };
        }
      });
    }
    return this.executeOnce(fetchSafety, options);
  }

  /**
   * Runs exactly one request and returns ITS OWN result to its direct
   * caller (`poll()`, or the recursive catch-up below). If a `poll()` call
   * coalesced onto a follow-up while this one was running, that follow-up
   * fires immediately afterward (still sequential — single-writer holds
   * throughout) via `drainFollowUp`, whose own result goes exclusively to
   * the resolvers that coalesced onto it, not to this call's caller.
   */
  private async executeOnce(fetchSafety: CastSafetyFetcher, options: CastSafetyPollOptions): Promise<CastSafetyPollResult> {
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const timeoutMs = options.timeoutMs ?? CAST_SAFETY_POLL_TIMEOUT_MS;
    const freshnessMs = options.freshnessMs ?? CAST_SAFETY_OBSERVATION_FRESHNESS_MS;
    // performance.now() (round 13b): monotonic, immune to a backward
    // wall-clock jump (NTP correction, or this feature's own deployment
    // target — a wall-mounted display resuming from sleep) making a stale
    // observation compute as artificially fresh. See the module doc.
    const issuedAt = performance.now();
    // No reason passed here (defaults to a generic AbortError) — deliberately
    // distinct from `INVALIDATE_ABORT_REASON`, so the checks below can tell
    // "the hygiene timeout fired" apart from "invalidate() abandoned this".
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const state = await fetchSafety(signal);
      if (signal.aborted && signal.reason === INVALIDATE_ABORT_REASON) {
        // Explicitly abandoned by invalidate() (identity change/unmount) —
        // drop outright regardless of value, even if the fetcher ignored
        // the signal and resolved anyway (round 8's backstop).
        return { kind: 'ignored' };
      }
      if (state.active) {
        this.lastConfirmedAt = performance.now();
        return { kind: 'ok', active: true };
      }
      // This value's OWN round trip (issue to conclusion) must itself be
      // fresh to trust — a slow pre-hold `false` describes a moment that,
      // by delivery, may already be stale (round 11a). Because single-writer
      // guarantees `issuedAt >= lastConfirmedAt` (no overlapping requests),
      // this check is at least as strict as comparing against
      // `lastConfirmedAt` would be, so a fresh, fast `false` is always
      // trusted here regardless of how long ago the PRIOR confirmation was
      // — this new reading itself supersedes that gap.
      const concludedAt = performance.now();
      if (concludedAt - issuedAt > freshnessMs) return { kind: 'unknown' };
      this.lastConfirmedAt = concludedAt;
      return { kind: 'ok', active: false };
    } catch {
      // The specific error is never inspected: round 11c judges every
      // non-invalidate failure/timeout the same way, by elapsed time since
      // the last confirmation — not by which error it was or how long THIS
      // one took (see below).
      if (signal.aborted && signal.reason === INVALIDATE_ABORT_REASON) {
        return { kind: 'ignored' };
      }
      // No value at all here — a genuine failure or the hygiene timeout
      // firing. Round 11c: judge this purely by how long it has been since
      // the last successful confirmation of ANY value, NOT by how long
      // THIS particular failure took. A single slow failure/timeout always
      // exceeds the freshness window this way too (by construction its
      // `issuedAt` predates `now` by at least `timeoutMs > freshnessMs`,
      // and `lastConfirmedAt <= issuedAt`) — but so does a BURST of
      // individually-fast failures whose cumulative gap since the last
      // confirmation has grown past the window, which a purely
      // this-request's-own-duration check (as round 11a used) would have
      // missed entirely: no single one of them is ever slow, so a
      // fast-failing outage could hold `castSafetyKnown` confidently
      // "inactive" indefinitely. `lastConfirmedAt === null` (nothing ever
      // confirmed) counts as expired too, matching the page's own fail-safe
      // starting state.
      if (this.lastConfirmedAt === null || performance.now() - this.lastConfirmedAt > freshnessMs) {
        return { kind: 'unknown' };
      }
      return { kind: 'failed' };
    } finally {
      clearTimeout(deadline);
      // Only release ownership if this call is STILL the current owner —
      // `invalidate()` may already have done so synchronously (round 11b),
      // in which case a NEWER call already owns `busy`/`controller` and
      // this abandoned call must not clobber it.
      if (this.controller === controller) {
        this.busy = false;
        this.controller = null;
        // Fire-and-forget: any follow-up that coalesced while THIS request
        // was running fires immediately, right now — a microtask after this
        // `finally`, strictly before any externally-scheduled tick (a
        // macrotask) could otherwise have started one (round 13a). This
        // does not affect what THIS call returns to ITS caller; the
        // follow-up's own result reaches only the resolvers that coalesced
        // onto it, via `drainFollowUp`.
        this.drainFollowUp();
      }
    }
  }

  /** Starts the currently-pending follow-up (if any) and, once it
   * concludes, resolves every caller that coalesced onto it with its real
   * result — then checks again, in case further calls coalesced onto a
   * NEW follow-up while this one was itself running (recursion here is
   * bounded by real request completions, never by ticks alone). */
  private drainFollowUp(): void {
    const followUp = this.followUp;
    if (!followUp) return;
    this.followUp = null;
    void this.executeOnce(followUp.fetchSafety, followUp.options).then((result) => {
      for (const resolve of followUp.resolvers) resolve(result);
    });
  }

  /**
   * Abort the in-flight request, if any, and free the poller immediately —
   * call on unmount / cast identity change. Freeing it here (not waiting
   * for the aborted call's own `finally`, which only runs after the abort
   * rejects the awaited fetch as a microtask) matters because the very
   * next React effect body calls `poll()` again synchronously afterward
   * (the new identity's mount-time check); without this, that call would
   * see the poller still marked busy and be skipped, delaying the new
   * identity's first check by up to one poll interval for no reason
   * (round 11b). A later `poll()` call (e.g. cast mode re-entered) is
   * otherwise unaffected — this is a one-time flush, not a permanent
   * shutdown. `lastConfirmedAt` is also cleared: a confirmation from the
   * OLD identity must never lend false confidence to the NEW one's early
   * failures. Any coalesced follow-up that hadn't started yet is dropped
   * (it belonged to the OLD identity — round 13a) and its waiting
   * resolvers are settled with `{ kind: 'ignored' }` rather than left
   * hanging forever.
   */
  invalidate(): void {
    this.controller?.abort(INVALIDATE_ABORT_REASON);
    this.controller = null;
    this.busy = false;
    this.lastConfirmedAt = null;
    const followUp = this.followUp;
    this.followUp = null;
    if (followUp) {
      for (const resolve of followUp.resolvers) resolve({ kind: 'ignored' });
    }
  }
}

/**
 * Run one cast-safety poll tick against `poller`. A thin wrapper — kept as
 * a free function (rather than requiring callers to hold and call the
 * class method directly) to match this module's existing
 * `run*`-function-plus-sequencer-object shape and minimize call-site churn.
 */
export async function runCastSafetyPoll(
  poller: CastSafetyPoller,
  fetchSafety: CastSafetyFetcher,
  options: { timeoutMs?: number; freshnessMs?: number } = {},
): Promise<CastSafetyPollResult> {
  return poller.poll(fetchSafety, options);
}

/**
 * Commit-site guard for the cast-safety poll's identity boundary (issue
 * #1908 rework — orthogonal to, and unaffected by, the single-writer
 * redesign above: this is a component-level concern, not a poll-ordering
 * one).
 *
 * The poller above only guarantees ordering WITHIN one cast identity
 * (token); it has no notion of the identity itself changing. On an SPA
 * transition between two cast tokens, `PlayerDisplayPage` resets its
 * `castSafetyActive`/`castSafetyKnown` state to "unknown" DURING RENDER (see
 * that component's doc), but `poller.invalidate()` — which aborts the old
 * identity's in-flight poll — only runs afterward, in the OLD effect's
 * passive cleanup. Between those two points, the old identity's poll is, as
 * far as the poller is concerned, an entirely ordinary in-flight request;
 * if it resolves in that window, `runCastSafetyPoll` has no way to know a
 * component-level identity change is pending and can legitimately resolve
 * `ok`. Applying that result would use the OLD identity's value to set the
 * NEW identity's state — no poller design, however it orders requests
 * WITHIN an identity, can close this gap on its own, because it operates
 * entirely within one identity and never sees the boundary.
 *
 * The fix lives at the call site, not as another sequencing/abort layer:
 * capture the identity a call was actually made FOR before its `await`, and
 * before applying an `ok` result, check that capture against whatever the
 * page's identity ref holds by the time the promise resolves. A mismatch
 * means a later identity change has already superseded this call, and the
 * result must be dropped exactly like an ordinary ignored one.
 */
export function shouldApplyCastSafetyResult(
  result: CastSafetyPollResult,
  requestIdentity: string,
  currentIdentity: string | null,
): result is { kind: 'ok'; active: boolean } {
  return result.kind === 'ok' && requestIdentity === currentIdentity;
}

/**
 * Same identity-boundary guard as `shouldApplyCastSafetyResult`, for the
 * `{ kind: 'unknown' }` outcome (round 11a): a too-old observation for an
 * identity the page has already moved on from must not touch the CURRENT
 * identity's state either way — the render-time reset already put the new
 * identity into "unknown" on its own, so this is a pure no-op in that case,
 * but the check stays for the same reason `shouldApplyCastSafetyResult`'s
 * does: correctness should not depend on that being a coincidence.
 */
export function shouldMarkCastSafetyUnknown(
  result: CastSafetyPollResult,
  requestIdentity: string,
  currentIdentity: string | null,
): boolean {
  return result.kind === 'unknown' && requestIdentity === currentIdentity;
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Couldn't load the display.";
}

/**
 * After a sequenced refresh fails:
 *   - transient (`keepLastKnown`): leave the prior paint alone;
 *   - persistent with a summary from this load: keep the cast, drop only the
 *     initiative rail (matches pre-#743 nested try/catch behavior);
 *   - persistent with no summary: clear this campaign's projection so the
 *     page can show the full-screen error.
 */
export function projectionAfterLoadFailure(
  current: PlayerDisplayProjection | null,
  campaignId: number,
  options: { keepLastKnown: boolean; summary?: CampaignSummary | null },
): PlayerDisplayProjection | null {
  if (options.keepLastKnown) return current;
  if (options.summary) {
    return { campaignId, summary: options.summary, encounter: null };
  }
  if (current?.campaignId === campaignId) return null;
  return current;
}

/**
 * Run one sequenced load. Superseded/aborted work returns `ignored`; transient
 * failures ask the caller to keep last-known state rather than clearing the rail.
 */
export async function runPlayerDisplayLoad(
  sequencer: PlayerDisplayLoadSequencer,
  campaignId: number,
  fetchers: PlayerDisplayFetchers,
  options: { hadProjection: boolean } = { hadProjection: false },
): Promise<PlayerDisplayLoadResult> {
  if (!Number.isFinite(campaignId)) {
    return {
      kind: 'ignored',
      generation: sequencer.currentGeneration,
      reason: 'campaign-changed',
    };
  }

  const { generation, signal } = sequencer.begin(campaignId);
  // Capture summary as soon as it resolves so a later rail failure can still
  // keep the cast painted (drop encounter only) instead of wiping the page.
  let fetchedSummary: CampaignSummary | null = null;
  const capturingFetchers: PlayerDisplayFetchers = {
    getSummary: async (id, sig) => {
      const summary = await fetchers.getSummary(id, sig);
      fetchedSummary = summary;
      return summary;
    },
    getRunningEncounters: fetchers.getRunningEncounters,
    getEncounter: fetchers.getEncounter,
  };
  try {
    const projection = await fetchPlayerDisplayProjection(campaignId, capturingFetchers, signal);
    if (!sequencer.isCurrent(generation, campaignId)) {
      return {
        kind: 'ignored',
        generation,
        reason: sequencer.activeCampaign === campaignId ? 'superseded' : 'campaign-changed',
      };
    }
    return { kind: 'ok', generation, projection };
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return { kind: 'ignored', generation, reason: 'aborted' };
    }
    if (!sequencer.isCurrent(generation, campaignId)) {
      return {
        kind: 'ignored',
        generation,
        reason: sequencer.activeCampaign === campaignId ? 'superseded' : 'campaign-changed',
      };
    }
    const transient = isTransientError(error);
    return {
      kind: 'failed',
      generation,
      message: failureMessage(error),
      // Keep the TV painted on transient blips when we already showed something.
      // A first-load failure still surfaces the error screen (nothing to keep).
      keepLastKnown: transient && options.hadProjection,
      transient,
      summary: fetchedSummary,
    };
  }
}
