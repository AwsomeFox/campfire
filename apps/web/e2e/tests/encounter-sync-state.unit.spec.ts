/**
 * Run-session encounter sync indicator + guarded actions (issue #471).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveEncounterSyncState,
  encounterResyncAdvanced,
  encounterRiskyActionsBlocked,
  encounterSyncBannerMessage,
  encounterSyncChipLabel,
  encounterSyncRevisionFromUpdatedAt,
  ENCOUNTER_SYNC_BANNER_TESTID,
  ENCOUNTER_SYNC_CHIP_TESTID,
} from '../../src/features/encounters/encounterSyncState';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('encounter sync state (issue #471)', () => {
  test('maps SSE + read freshness into live/connecting/reconnecting/offline/stale', () => {
    expect(
      deriveEncounterSyncState({ eventStatus: null, readStale: false, resyncPending: false }),
    ).toBe('connecting');
    expect(
      deriveEncounterSyncState({ eventStatus: 'connected', readStale: false, resyncPending: false }),
    ).toBe('live');
    expect(
      deriveEncounterSyncState({ eventStatus: 'connecting', readStale: false, resyncPending: false }),
    ).toBe('connecting');
    expect(
      deriveEncounterSyncState({ eventStatus: 'reconnecting', readStale: false, resyncPending: false }),
    ).toBe('reconnecting');
    expect(
      deriveEncounterSyncState({ eventStatus: 'offline', readStale: false, resyncPending: false }),
    ).toBe('offline');
    expect(
      deriveEncounterSyncState({ eventStatus: 'connected', readStale: true, resyncPending: false }),
    ).toBe('stale');
    expect(
      deriveEncounterSyncState({ eventStatus: 'connected', readStale: false, resyncPending: true }),
    ).toBe('stale');
    expect(
      deriveEncounterSyncState({ eventStatus: 'stopped', readStale: false, resyncPending: false }),
    ).toBe('stale');
    expect(
      deriveEncounterSyncState({
        eventStatus: 'connected',
        readStale: false,
        resyncPending: false,
        staleIdentity: true,
      }),
    ).toBe('offline');
  });

  test('risky combat actions are blocked unless live', () => {
    expect(encounterRiskyActionsBlocked('live')).toBe(false);
    expect(encounterRiskyActionsBlocked('connecting')).toBe(true);
    expect(encounterRiskyActionsBlocked('reconnecting')).toBe(true);
    expect(encounterRiskyActionsBlocked('offline')).toBe(true);
    expect(encounterRiskyActionsBlocked('stale')).toBe(true);
  });

  test('banner copy covers offline/reconnecting/stale/connecting', () => {
    expect(encounterSyncBannerMessage('live')).toBeNull();
    expect(encounterSyncBannerMessage('offline')).toMatch(/Offline/);
    expect(encounterSyncBannerMessage('reconnecting')).toMatch(/Reconnecting/);
    expect(encounterSyncBannerMessage('stale')).toMatch(/interrupted/);
    expect(encounterSyncBannerMessage('connecting')).toMatch(/Connecting/);
  });

  test('chip labels expose operator-facing states', () => {
    expect(encounterSyncChipLabel('live')).toBe('Live');
    expect(encounterSyncChipLabel('reconnecting')).toBe('Reconnecting');
    expect(encounterSyncChipLabel('offline')).toBe('Offline');
    expect(encounterSyncChipLabel('stale')).toBe('Stale');
  });

  test('resync revision tracks updatedAt and detects advancement', () => {
    const first = encounterSyncRevisionFromUpdatedAt('2026-07-25T12:00:00.000Z', 1_000);
    expect(first.syncRevision).toBe('2026-07-25T12:00:00.000Z');
    expect(first.lastSyncAt).toBe(1_000);
    expect(encounterResyncAdvanced(null, first.syncRevision)).toBe(true);
    expect(encounterResyncAdvanced(first.syncRevision, first.syncRevision)).toBe(false);
    expect(encounterResyncAdvanced(first.syncRevision, '2026-07-25T12:00:05.000Z')).toBe(true);
  });

  test('RunSessionPage wires encounter sync state and guarded actions', () => {
    // Asserts against the exported pure-helper IDENTIFIERS (issue #1453) rather than
    // independently re-typed literals: the sync-chip/banner testids come from
    // ENCOUNTER_SYNC_CHIP_TESTID / ENCOUNTER_SYNC_BANNER_TESTID (checked for VALUE
    // below), so a rename only requires updating the shared constant, not this file
    // and the page's JSX in lockstep.
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/deriveEncounterSyncState/);
    expect(source).toMatch(/encounterRiskyActionsBlocked/);
    expect(source).toMatch(/data-testid=\{ENCOUNTER_SYNC_CHIP_TESTID\}/);
    expect(source).toMatch(/data-testid=\{ENCOUNTER_SYNC_BANNER_TESTID\}/);
    expect(source).toMatch(/setResyncPending\(true\)/);
    expect(ENCOUNTER_SYNC_CHIP_TESTID).toBe('encounter-sync-chip');
    expect(ENCOUNTER_SYNC_BANNER_TESTID).toBe('encounter-sync-banner');
  });
});
