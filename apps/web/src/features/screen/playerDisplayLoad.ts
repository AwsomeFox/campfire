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
 * visible-tab cadence as the rest of this page. This mechanism went through
 * several shapes, each closing one failure mode and (because it coupled
 * "when the next tick may run" to "when this one finishes") opening another:
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
 *     all. Widening the deadline (30s) fixes that, but reopens (3) in a
 *     bounded form: coupling "next tick may run" to "this request settled"
 *     means a single hang can still delay observing a freshly-raised hold by
 *     up to the deadline — incompatible with the 15s acceptance bound this
 *     feature is built around, however generous the deadline's own value.
 *  5. Fix (4) by decoupling ticking from completion (every tick starts a
 *     genuinely new, never-aborted request), gated only by a generation
 *     watermark that advances on SUCCESS: closes (4), but a poll succeeding
 *     is not the only way it can conclude. If a newer poll fails or is
 *     aborted (never calling the success-only watermark update) while an
 *     OLDER poll is still outstanding, the older one's late — and by then
 *     possibly stale — success can still land after the newer attempt
 *     already gave up inconclusively, clearing the curtain with out-of-date
 *     data even though a fresher check was already attempted.
 *
 * The fix is to stop coupling ticking to completion, AND to advance the
 * ordering watermark on every conclusion, not only successful ones. Every
 * visible-tab tick starts a genuinely NEW request — never skipped, never
 * aborted just because a new tick fired — so an outstanding request
 * (however slow, however hung) can never block a later one from running.
 * Ordering is handled separately, by a monotonic generation: each poll gets
 * a generation number, and `settle()` records that a generation has
 * concluded — with ANY outcome, success, failure, or abort — returning
 * whether that generation is still the freshest to have concluded. Only a
 * still-freshest generation's success may ever be applied. This keeps the
 * out-of-order guarantee from (1)/(2) — a late, low-numbered response can
 * never overwrite a result a higher-numbered one already applied, even if it
 * "completes" without ever being aborted — closes (5) by no longer letting a
 * response's own success be the only thing that can supersede it, and keeps
 * (2)'s and (3)'s starvation modes structurally impossible: no tick is ever
 * skipped, and no in-flight request is ever aborted by a newer tick starting.
 *
 * `CAST_SAFETY_POLL_TIMEOUT_MS` still exists, but its job changed: it is no
 * longer a correctness deadline (nothing depends on it to keep polling
 * alive), only a resource-hygiene cap so a connection that hangs forever
 * doesn't accumulate open requests indefinitely. Because nothing depends on
 * its exact value for correctness anymore, it can be — and is — set
 * generously, with no tension against the 15s bound: a freshly-raised hold
 * is observed by the next scheduled tick (at most one 5s poll interval away)
 * succeeding on its own, entirely independent of whatever a prior hung
 * request is still doing.
 */
export type CastSafetyFetcher = (signal: AbortSignal) => Promise<CastSafetyState>;

/** Resource-hygiene cap on a single safety poll request — NOT a correctness
 * deadline. No poll's ability to run or to be applied depends on this value;
 * it only bounds how long a connection that never settles on its own stays
 * open before being cleaned up. See the module doc above. */
export const CAST_SAFETY_POLL_TIMEOUT_MS = 30_000;

export type CastSafetyPollResult =
  | { kind: 'ok'; active: boolean }
  /** This response arrived, but a newer generation was already applied —
   * out-of-order, correctly ignored. */
  | { kind: 'stale' }
  /** Aborted (unmount / identity change, or the hygiene timeout). */
  | { kind: 'ignored' }
  /** Real (non-abort) failure. Callers must fail safe: leave the last-known
   * hold state untouched rather than clearing an active curtain or guessing
   * a new value. */
  | { kind: 'failed' };

export class CastSafetyPollSequencer {
  private generation = 0;
  private settledGeneration = 0;
  private inFlight = new Map<number, AbortController>();

  /** Start a new poll. Always succeeds — never blocked or superseded by a
   * prior poll that hasn't settled yet, so an outstanding request (slow,
   * stalled, or otherwise) can never prevent this one from running. */
  begin(): { generation: number; controller: AbortController } {
    this.generation += 1;
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlight.set(generation, controller);
    return { generation, controller };
  }

  /** Stop tracking a settled poll (success, failure, or abort) so it no
   * longer counts toward in-flight bookkeeping / `invalidate()`'s abort set. */
  end(generation: number): void {
    this.inFlight.delete(generation);
  }

  /**
   * Record that `generation` has settled — with ANY outcome: a successful
   * response, a genuine failure, or an abort. Returns whether `generation`'s
   * own value (if it succeeded) may still be trusted: true only if no NEWER
   * generation had already settled by the time this one finished.
   *
   * Settling is tracked for every outcome, not just successes: if it only
   * advanced on success, a newer poll that itself fails, times out, or is
   * aborted would never raise the watermark, and a slower OLDER poll's late
   * (and by then possibly stale) success could still land after it —
   * clearing the curtain with out-of-date data even though a fresher check
   * was already attempted and came back inconclusive. Once any newer attempt
   * has concluded, an older one is stale regardless of how it concludes: the
   * fail-safe stance is to keep the last-known state rather than trust a
   * result real-world time has already moved past.
   */
  settle(generation: number): boolean {
    const isFreshest = generation > this.settledGeneration;
    if (isFreshest) this.settledGeneration = generation;
    return isFreshest;
  }

  /**
   * Abort every currently in-flight poll. Call on unmount / cast identity
   * (token) change so a response arriving after that point cannot commit.
   * Also raises the settled watermark to the current generation, so even a
   * request that ignores its abort signal and "completes" later can never
   * apply — the same backstop-beyond-cancellation property `settle()` gives
   * every other case. Future `begin()` calls (e.g. cast mode re-entered) are
   * unaffected — this is a one-time flush, not a permanent shutdown.
   */
  invalidate(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.settledGeneration = this.generation;
  }
}

/**
 * Run one cast-safety poll tick. Always starts a fresh request — never
 * skipped, never aborts a still-running earlier poll — so an outstanding
 * request can never block this or any later tick. Only a response whose
 * generation is still the freshest SETTLED one may ever be applied
 * (`kind: 'ok'`) — an out-of-order arrival (including one superseded by a
 * newer poll that itself failed or aborted) resolves `stale`, aborted work
 * resolves `ignored`, and a genuine failure resolves `failed`, so the caller
 * can fail safe (keep last-known state) instead of guessing a value.
 * `timeoutMs` bounds this one request's own lifetime purely for resource
 * hygiene — see `CAST_SAFETY_POLL_TIMEOUT_MS`'s doc for why it carries no
 * correctness weight here.
 */
export async function runCastSafetyPoll(
  sequencer: CastSafetyPollSequencer,
  fetchSafety: CastSafetyFetcher,
  options: { timeoutMs?: number } = {},
): Promise<CastSafetyPollResult> {
  const { generation, controller } = sequencer.begin();
  const { signal } = controller;
  const timeoutMs = options.timeoutMs ?? CAST_SAFETY_POLL_TIMEOUT_MS;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const state = await fetchSafety(signal);
    const isFreshest = sequencer.settle(generation);
    if (!isFreshest) return { kind: 'stale' };
    return { kind: 'ok', active: state.active };
  } catch (error) {
    // Settle even on failure/abort — a later-arriving OLDER response must
    // see this generation as having concluded, regardless of how it
    // concluded. See `settle()`'s doc for why this is the fix, not an
    // incidental detail.
    sequencer.settle(generation);
    if (isAbortError(error) || signal.aborted) {
      return { kind: 'ignored' };
    }
    return { kind: 'failed' };
  } finally {
    clearTimeout(deadline);
    sequencer.end(generation);
  }
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
