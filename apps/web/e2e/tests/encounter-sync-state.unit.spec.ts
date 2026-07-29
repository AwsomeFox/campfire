/**
 * Run-session encounter sync indicator + guarded actions (issue #471, extended by #1446).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONNECTING_GRACE_MS,
  confirmEncounterOverride,
  deriveEncounterSyncState,
  ENCOUNTER_OVERRIDE_INACTIVE,
  encounterActionsBlocked,
  encounterOverrideOfferable,
  encounterResyncAdvanced,
  encounterRiskyActionsBlocked,
  encounterSyncBannerMessage,
  encounterSyncChipLabel,
  encounterSyncOverrideBannerKey,
  encounterSyncRevisionFromUpdatedAt,
  isConnectingGraceElapsed,
  revokeEncounterOverrideIfUnauthorized,
  settleEncounterOverride,
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
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/deriveEncounterSyncState/);
    expect(source).toMatch(/encounterActionsBlocked/);
    expect(source).toMatch(/data-testid="encounter-sync-chip"/);
    expect(source).toMatch(/data-testid="encounter-sync-banner"/);
    expect(source).toMatch(/setResyncPending\(true\)/);
    // Issue #1446: the override affordance and its persistence must be wired, not just defined.
    expect(source).toMatch(/data-testid="encounter-sync-override-prompt"/);
    expect(source).toMatch(/data-testid="encounter-sync-override-confirm"/);
    expect(source).toMatch(/confirmEncounterOverride/);
    expect(source).toMatch(/settleEncounterOverride/);
    // Issue #1446 review fix: DM-gated, and the banner swaps to override-aware copy.
    expect(source).toMatch(/canDmWrite\s*&&\s*encounterOverrideOfferable/);
    expect(source).toMatch(/encounterSyncOverrideBannerKey/);
    // Issue #1446 review fix (round 4): the override must not survive loss of DM
    // authority — revoked in the persisted state AND masked atomically at render time.
    expect(source).toMatch(/revokeEncounterOverrideIfUnauthorized/);
    expect(source).toMatch(/canDmWrite \? encounterSyncOverride : ENCOUNTER_OVERRIDE_INACTIVE/);
  });
});

/**
 * Issue #1446 — the stale-sync gate had no override, so an environment where SSE never
 * connects made combat permanently unrunnable. These cover the override state machine
 * and the first-load `connecting` grace timeout in isolation from the component.
 */
test.describe('encounter sync override + connecting grace (issue #1446)', () => {
  test('first-load connecting degrades to an overridable offline only after the grace period', () => {
    // Still within grace: stays `connecting`, not yet overridable.
    expect(
      deriveEncounterSyncState({
        eventStatus: 'connecting',
        readStale: false,
        resyncPending: false,
        connectingGraceElapsed: false,
      }),
    ).toBe('connecting');
    expect(encounterOverrideOfferable('connecting')).toBe(false);

    // Past grace: an environment where SSE never connects must not block forever —
    // it now reads the same as a confirmed outage and becomes overridable.
    expect(
      deriveEncounterSyncState({
        eventStatus: 'connecting',
        readStale: false,
        resyncPending: false,
        connectingGraceElapsed: true,
      }),
    ).toBe('offline');
    expect(encounterOverrideOfferable('offline')).toBe(true);

    // A null eventStatus (never even attempted) is treated the same as 'connecting'.
    expect(
      deriveEncounterSyncState({
        eventStatus: null,
        readStale: false,
        resyncPending: false,
        connectingGraceElapsed: true,
      }),
    ).toBe('offline');
  });

  test('isConnectingGraceElapsed is a pure, boundary-correct time check', () => {
    expect(isConnectingGraceElapsed(null, Date.now())).toBe(false);
    const since = 1_000;
    expect(isConnectingGraceElapsed(since, since + CONNECTING_GRACE_MS - 1)).toBe(false);
    expect(isConnectingGraceElapsed(since, since + CONNECTING_GRACE_MS)).toBe(true);
    expect(isConnectingGraceElapsed(since, since + CONNECTING_GRACE_MS + 5_000)).toBe(true);
  });

  test('override affordance is never offered while live, and never during the initial connecting grace', () => {
    expect(encounterOverrideOfferable('live')).toBe(false);
    expect(encounterOverrideOfferable('connecting')).toBe(false);
    expect(encounterOverrideOfferable('reconnecting')).toBe(true);
    expect(encounterOverrideOfferable('offline')).toBe(true);
    expect(encounterOverrideOfferable('stale')).toBe(true);
  });

  test('override state machine: live -> reconnecting -> offline -> live -> stale (re-confirm required)', () => {
    let override = ENCOUNTER_OVERRIDE_INACTIVE;
    expect(override.active).toBe(false);
    expect(encounterActionsBlocked('live', override)).toBe(false);

    // Stream drops: actions are blocked until the DM explicitly confirms.
    expect(encounterActionsBlocked('reconnecting', override)).toBe(true);
    override = confirmEncounterOverride();
    expect(override.active).toBe(true);
    expect(encounterActionsBlocked('reconnecting', override)).toBe(false);

    // Settling on every sync-state change is a no-op while still not live — a DM mid-combat
    // must not be asked to reconfirm on every reconnect/offline flop.
    override = settleEncounterOverride(override, 'reconnecting');
    expect(override.active).toBe(true);
    override = settleEncounterOverride(override, 'offline');
    expect(override.active).toBe(true);
    expect(encounterActionsBlocked('offline', override)).toBe(false);

    // Stream recovers: the override is consumed (session-scoped to ONE outage).
    override = settleEncounterOverride(override, 'live');
    expect(override.active).toBe(false);
    expect(encounterActionsBlocked('live', override)).toBe(false);

    // A LATER, separate outage must be re-confirmed — it does not silently sail through
    // on the earlier confirmation (this is the actual "cannot confirm 17 times" AND
    // "cannot clobber via a stale confirmation" balance the issue asks for).
    expect(encounterActionsBlocked('stale', override)).toBe(true);
    expect(encounterOverrideOfferable('stale')).toBe(true);
  });

  test('revokeEncounterOverrideIfUnauthorized clears an active override the instant DM authority is lost (issue #1446 review fix)', () => {
    let override = confirmEncounterOverride();
    expect(override.active).toBe(true);

    // Still a DM: untouched.
    override = revokeEncounterOverrideIfUnauthorized(override, true);
    expect(override.active).toBe(true);

    // Demoted: the override is REVOKED (cleared), not merely masked — a later
    // re-promotion must require a fresh confirmation, matching the acceptance
    // criterion's "revoked on demotion" (not "temporarily hidden").
    override = revokeEncounterOverrideIfUnauthorized(override, false);
    expect(override.active).toBe(false);
    expect(encounterActionsBlocked('offline', override)).toBe(true);

    // Idempotent / no-op when there's nothing to revoke.
    expect(revokeEncounterOverrideIfUnauthorized(ENCOUNTER_OVERRIDE_INACTIVE, false)).toBe(ENCOUNTER_OVERRIDE_INACTIVE);
  });

  test('encounterRiskyActionsBlocked (base primitive) is unaffected by the override layer', () => {
    // encounterActionsBlocked composes on top of this — the base "not live" check itself
    // must stay override-agnostic so callers that intentionally never honor an override
    // (none currently do, but the primitive is still a correct standalone building block).
    expect(encounterRiskyActionsBlocked('live')).toBe(false);
    expect(encounterRiskyActionsBlocked('offline')).toBe(true);
  });

  test('override-active banner copy never claims actions are paused (issue #1446 review fix)', () => {
    // The base (non-override) banner legitimately says actions are paused — that's true
    // while the DM hasn't confirmed yet.
    expect(encounterSyncBannerMessage('offline')).toMatch(/paused/i);
    // Once the override is active, the SAME state must resolve to a DIFFERENT, override-aware
    // key whose (English) copy does not claim anything is paused/blocked, while still warning
    // about stale data.
    for (const state of ['offline', 'reconnecting', 'stale'] as const) {
      const key = encounterSyncOverrideBannerKey(state);
      expect(key).not.toBeNull();
      expect(key).toMatch(/^encounters\.sync\.bannerOverride/);
    }
    // `live` (nothing to warn about) and `connecting` (unreachable while an override is
    // active — encounterOverrideOfferable never offers one during the initial grace) have
    // no override-banner variant.
    expect(encounterSyncOverrideBannerKey('live')).toBeNull();
    expect(encounterSyncOverrideBannerKey('connecting')).toBeNull();
  });
});
