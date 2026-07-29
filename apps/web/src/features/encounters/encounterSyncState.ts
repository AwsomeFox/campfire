/**
 * Run-session encounter sync state (issue #471, extended by #1446).
 *
 * SSE silently retries while the encounter UI stays actionable, so turn order, HP,
 * fog, and tokens may be stale. This module derives a single sync indicator from
 * the campaign events stream plus successful encounter reads, tracks the last
 * confirmed `updatedAt` revision for reconnect resync, and gates conflict-prone
 * combat actions while not live. Safe UI (expanded cards, in-progress rolls,
 * refresh) stays up.
 *
 * Issue #1446: an environment where SSE never connects (proxy buffering, a
 * terminated long-lived connection, a per-origin connection cap) made the block
 * permanent — there was no way past it even though the server already rejects a
 * genuinely stale write (see `TURN_ALREADY_ADVANCED` / `expectedCurrentCombatantId`).
 * This module now also models a session-scoped "continue anyway" override: it stays
 * granted for as long as the stream remains unhealthy, and is consumed the moment
 * the stream returns to `live` (a LATER outage must be re-confirmed). A first-load
 * `connecting` is given a short grace period before it is treated as a genuine
 * outage — see {@link CONNECTING_GRACE_MS} — so the override is never offered for
 * an ordinary sub-second cold connect.
 */

import type { CampaignEventsStatus } from '../../lib/useCampaignEvents';

export type EncounterSyncState = 'live' | 'connecting' | 'reconnecting' | 'offline' | 'stale';

export type EncounterSyncInput = {
  eventStatus: CampaignEventsStatus | null;
  /** True when the latest encounter read failed transiently but last-known data renders. */
  readStale: boolean;
  /** True after onReconnect/onStreamRecovery until the next successful encounter read settles. */
  resyncPending: boolean;
  staleIdentity?: boolean;
  /**
   * True once the CURRENT first-load `connecting` attempt has run longer than
   * {@link CONNECTING_GRACE_MS} (issue #1446). A genuine cold-start connect is
   * expected to settle in well under a second; only past the grace period is it
   * treated the same as a confirmed outage (`offline`) so the override becomes
   * available rather than blocking forever.
   */
  connectingGraceElapsed?: boolean;
};

/** Map SSE transport + read freshness into one operator-facing sync state. */
export function deriveEncounterSyncState(input: EncounterSyncInput): EncounterSyncState {
  if (input.staleIdentity || input.eventStatus === 'offline') return 'offline';
  if (input.eventStatus === 'reconnecting') return 'reconnecting';
  if (input.resyncPending || input.readStale) return 'stale';
  if (input.eventStatus === 'stopped') return 'stale';
  if (input.eventStatus === 'connecting' || input.eventStatus == null) {
    // Issue #1446: a first-load connect that never settles must eventually stop
    // blocking forever. Treat it as a confirmed outage (not a distinct "give up"
    // state) once past the grace period — same override path as offline/reconnecting.
    return input.connectingGraceElapsed ? 'offline' : 'connecting';
  }
  return 'live';
}

/** Conflict-prone combat mutations should not fire while the stream/read path is unhealthy. */
export function encounterRiskyActionsBlocked(state: EncounterSyncState): boolean {
  return state !== 'live';
}

/**
 * How long a first-load `connecting` is given before it is treated as a genuine
 * outage (issue #1446). Generous relative to a normal cold connect (sub-second)
 * so the grace period is never visible on a healthy network, while still bounded
 * so an environment where SSE never connects becomes overridable within one
 * game-night-relevant wait, not "reload and hope".
 */
export const CONNECTING_GRACE_MS = 6_000;

/** Pure time check the component wires to a timer — kept separate from `Date.now()` for tests. */
export function isConnectingGraceElapsed(connectingSince: number | null, now: number): boolean {
  return connectingSince != null && now - connectingSince >= CONNECTING_GRACE_MS;
}

/**
 * Session-scoped "continue anyway" override (issue #1446). `active` unblocks
 * conflict-prone actions while the sync state is not `live`; it is granted only by
 * an explicit DM confirmation ({@link confirmEncounterOverride}) and consumed the
 * moment the stream is `live` again ({@link settleEncounterOverride}), so a later,
 * separate outage prompts again rather than silently sailing through.
 */
export type EncounterOverrideState = { active: boolean };

export const ENCOUNTER_OVERRIDE_INACTIVE: EncounterOverrideState = { active: false };

/** Grant the override — call this from the "Continue anyway" confirmation. */
export function confirmEncounterOverride(): EncounterOverrideState {
  return { active: true };
}

/**
 * Consume a granted override once the stream is genuinely `live` again. Idempotent
 * (returns the same reference) when there is nothing to settle, so it is cheap to
 * call unconditionally on every sync-state change.
 */
export function settleEncounterOverride(
  override: EncounterOverrideState,
  syncState: EncounterSyncState,
): EncounterOverrideState {
  if (syncState === 'live' && override.active) return ENCOUNTER_OVERRIDE_INACTIVE;
  return override;
}

/**
 * Whether the "Continue anyway" affordance should be offered at all: not while
 * live (nothing to override), and not during the initial connecting grace period
 * (a genuine sub-second cold connect should just block quietly, not prompt).
 */
export function encounterOverrideOfferable(state: EncounterSyncState): boolean {
  return state !== 'live' && state !== 'connecting';
}

/**
 * The actual action gate: conflict-prone mutations are blocked unless the stream is
 * live OR the DM has confirmed the override for this outage.
 */
export function encounterActionsBlocked(state: EncounterSyncState, override: EncounterOverrideState): boolean {
  return encounterRiskyActionsBlocked(state) && !override.active;
}

export function encounterSyncChipClass(state: EncounterSyncState): string {
  switch (state) {
    case 'live':
      return 'cf-chip-online';
    case 'offline':
      return 'cf-chip-offline';
    default:
      return 'cf-chip-neutral';
  }
}

export function encounterSyncChipLabel(state: EncounterSyncState): string {
  switch (state) {
    case 'live':
      return 'Live';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'offline':
      return 'Offline';
    case 'stale':
      return 'Stale';
  }
}

export function encounterSyncBannerMessage(state: EncounterSyncState): string | null {
  switch (state) {
    case 'offline':
      return 'Offline — showing last-known encounter. Combat actions are paused.';
    case 'reconnecting':
      return 'Reconnecting — combat actions paused until live again.';
    case 'stale':
      return 'Live updates interrupted — combat actions paused until resynced.';
    case 'connecting':
      return 'Connecting to live updates…';
    default:
      return null;
  }
}

/**
 * i18n catalog key (under `encounters.sync.*`) for the banner while a "continue anyway"
 * override is active (issue #1446 review fix). {@link encounterSyncBannerMessage}'s copy
 * ("actions are paused") becomes actively FALSE the instant the override unblocks
 * controls — screen-reader users get a live-region announcement that contradicts what
 * just became interactive, and sighted users read the same contradiction. This variant
 * keeps the stale-data warning (the banner must stay visible per the issue) without
 * claiming anything is blocked. Returns null for `live` (no banner) and `connecting`
 * (unreachable while an override is active — {@link encounterOverrideOfferable} never
 * offers one during the initial connecting grace).
 */
export function encounterSyncOverrideBannerKey(state: EncounterSyncState): string | null {
  switch (state) {
    case 'offline':
      return 'encounters.sync.bannerOverrideOffline';
    case 'reconnecting':
      return 'encounters.sync.bannerOverrideReconnecting';
    case 'stale':
      return 'encounters.sync.bannerOverrideStale';
    case 'connecting':
    default:
      return null;
  }
}

/** Snapshot written after each successful encounter read. */
export type EncounterSyncRevision = {
  lastSyncAt: number;
  syncRevision: string;
};

export function encounterSyncRevisionFromUpdatedAt(
  updatedAt: string,
  at: number = Date.now(),
): EncounterSyncRevision {
  return { lastSyncAt: at, syncRevision: updatedAt };
}

/** True when a reconnect resync advanced the server revision (or first sync). */
export function encounterResyncAdvanced(previous: string | null, next: string): boolean {
  return previous !== next;
}
