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
 *   - on transient failure, keep last-known state and flag stale.
 *
 * Extracted so the e2e unit suite can drive every reorder / End-during-load /
 * campaign-change scenario without mounting React.
 */
import type { CampaignSummary, Encounter, EncounterWithCombatants } from '@campfire/schema';
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
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
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
   * Invalidate in-flight work when the route identity changes. The next
   * `begin()` starts a fresh generation for the new campaign.
   */
  invalidate(reason: 'unmount' | 'campaign-changed' = 'campaign-changed'): void {
    void reason;
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
    this.activeCampaignId = null;
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Couldn't load the display.";
}

/**
 * After a sequenced refresh fails: keep the prior paint on transient blips, but
 * drop this campaign's projection on persistent errors (404/403/…) so the
 * initiative rail cannot keep showing a fight the server no longer treats as live.
 */
export function projectionAfterLoadFailure(
  current: PlayerDisplayProjection | null,
  campaignId: number,
  keepLastKnown: boolean,
): PlayerDisplayProjection | null {
  if (keepLastKnown) return current;
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
  try {
    const projection = await fetchPlayerDisplayProjection(campaignId, fetchers, signal);
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
    };
  }
}
