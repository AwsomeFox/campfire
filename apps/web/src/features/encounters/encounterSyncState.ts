/**
 * Run-session encounter sync state (issue #471).
 *
 * SSE silently retries while the encounter UI stays actionable, so turn order, HP,
 * fog, and tokens may be stale. This module derives a single sync indicator from
 * the campaign events stream plus successful encounter reads, tracks the last
 * confirmed `updatedAt` revision for reconnect resync, and gates conflict-prone
 * combat actions while not live. Safe UI (expanded cards, in-progress rolls,
 * refresh) stays up.
 */

import type { CampaignEventsStatus } from '../../lib/useCampaignEvents';

export type EncounterSyncState = 'live' | 'connecting' | 'reconnecting' | 'offline' | 'stale';

/**
 * `data-testid` values for the sync chip and banner — a single source of truth
 * shared by RunSessionPage.tsx and its unit spec so the two cannot silently
 * drift apart (issue #1453: a spec that re-typed the literal independently
 * would keep passing after a copy/paste typo broke the real attribute).
 */
export const ENCOUNTER_SYNC_CHIP_TESTID = 'encounter-sync-chip';
export const ENCOUNTER_SYNC_BANNER_TESTID = 'encounter-sync-banner';

export type EncounterSyncInput = {
  eventStatus: CampaignEventsStatus | null;
  /** True when the latest encounter read failed transiently but last-known data renders. */
  readStale: boolean;
  /** True after onReconnect/onStreamRecovery until the next successful encounter read settles. */
  resyncPending: boolean;
  staleIdentity?: boolean;
};

/** Map SSE transport + read freshness into one operator-facing sync state. */
export function deriveEncounterSyncState(input: EncounterSyncInput): EncounterSyncState {
  if (input.staleIdentity || input.eventStatus === 'offline') return 'offline';
  if (input.eventStatus === 'reconnecting') return 'reconnecting';
  if (input.resyncPending || input.readStale) return 'stale';
  if (input.eventStatus === 'stopped') return 'stale';
  if (input.eventStatus === 'connecting' || input.eventStatus == null) return 'connecting';
  return 'live';
}

/** Conflict-prone combat mutations should not fire while the stream/read path is unhealthy. */
export function encounterRiskyActionsBlocked(state: EncounterSyncState): boolean {
  return state !== 'live';
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
