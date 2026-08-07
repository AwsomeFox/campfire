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
  encounterOverrideAuthorized,
  encounterOverrideOfferable,
  encounterResyncAdvanced,
  encounterRiskyActionsBlocked,
  encounterSyncBannerMessage,
  encounterSyncChipLabel,
  encounterSyncOverrideBannerKey,
  encounterSyncRevisionFromUpdatedAt,
  ENCOUNTER_SYNC_BANNER_TESTID,
  ENCOUNTER_SYNC_CHIP_TESTID,
  gateForWrite,
  isConnectingGraceElapsed,
  revokeEncounterOverrideIfUnauthorized,
  settleEncounterOverride,
  type EncounterOverrideAuthority,
  type EncounterOverrideState,
  type EncounterSyncState,
} from '../../src/features/encounters/encounterSyncState';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const DM_LIFECYCLE_HEADER = resolve(__dirname, '../../src/features/encounters/DmLifecycleHeader.tsx');

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
    // and the owning component's JSX in lockstep.
    const runSessionSource = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const lifecycleHeaderSource = readFileSync(DM_LIFECYCLE_HEADER, 'utf8');
    expect(runSessionSource).toMatch(/deriveEncounterSyncState/);
    expect(runSessionSource).toMatch(/encounterActionsBlocked/);
    expect(runSessionSource).toMatch(/data-testid=\{ENCOUNTER_SYNC_CHIP_TESTID\}/);
    expect(lifecycleHeaderSource).toMatch(/data-testid=\{ENCOUNTER_SYNC_BANNER_TESTID\}/);
    expect(ENCOUNTER_SYNC_CHIP_TESTID).toBe('encounter-sync-chip');
    expect(ENCOUNTER_SYNC_BANNER_TESTID).toBe('encounter-sync-banner');
    expect(runSessionSource).toMatch(/setResyncPending\(true\)/);
    // Issue #1446: the override affordance and its persistence must be wired, not just defined.
    expect(runSessionSource).toMatch(/data-testid="encounter-sync-override-prompt"/);
    expect(runSessionSource).toMatch(/data-testid="encounter-sync-override-confirm"/);
    expect(runSessionSource).toMatch(/confirmEncounterOverride/);
    expect(runSessionSource).toMatch(/settleEncounterOverride/);
    // Issue #1446 review fix: DM-gated, and the banner swaps to override-aware copy.
    expect(runSessionSource).toMatch(/overrideAuthority\.canDmWrite/);
    expect(runSessionSource).toMatch(/encounterSyncOverrideBannerKey/);
    // Issue #1446 review fix (round 4): the override must not survive loss of DM
    // authority — revoked in the persisted state AND masked atomically at render time.
    expect(runSessionSource).toMatch(/revokeEncounterOverrideIfUnauthorized/);
    // Issue #1446 review fix (round 5): stream/session-scoped sync state is explicitly
    // keyed to (campaignId, userId) — reset on a campaign or identity change, but NOT on
    // an encounter-only switch (that classification lives in the `[eid]` effect above).
    expect(runSessionSource).toMatch(/campaignStreamKey = `\$\{cid\}:\$\{me\?\.user\.id \?\? ''\}`/);
    // Issue #1446 review fix (final round): every override precondition — DM authority,
    // identity freshness, campaign match, identity match — is enumerated once in
    // encounterOverrideAuthorized and composed here as THE single gate, checked both at
    // confirm time (canDmWrite/staleIdentity guard the offer and the click handler) and
    // continuously (effectiveEncounterSyncOverride, re-derived every render).
    expect(runSessionSource).toMatch(/overrideAuthority\.staleIdentity/);
    expect(runSessionSource).toMatch(/encounterOverrideAuthorized\(\s*encounterSyncOverride,\s*overrideAuthority,?\s*\)/);
    expect(runSessionSource).toMatch(/confirmEncounterOverride\(overrideAuthority\.campaignId, overrideAuthority\.userId\)/);
    expect(runSessionSource).toMatch(/ownedCampaignStreamKey !== campaignStreamKey/);
    // Issue #1914: the scoped player override affordance and its wiring must also be
    // present, not just the DM one above.
    expect(runSessionSource).toMatch(/data-testid="encounter-sync-own-override-prompt"/);
    expect(runSessionSource).toMatch(/data-testid="encounter-sync-own-override-confirm"/);
    expect(runSessionSource).toMatch(/confirmEncounterOverride\(\s*overrideAuthority\.campaignId,\s*overrideAuthority\.userId,\s*'own-combatant',?\s*\)/);
    expect(runSessionSource).toMatch(/overrideAuthority\.canPlayerWrite/);
    expect(runSessionSource).toMatch(/gateForWrite/);
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
    override = confirmEncounterOverride(1, 42);
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

  test('revokeEncounterOverrideIfUnauthorized clears an active override the instant it is no longer authorized (issue #1446 review fix)', () => {
    let override = confirmEncounterOverride(1, 42);
    expect(override.active).toBe(true);

    // Still authorized: untouched.
    override = revokeEncounterOverrideIfUnauthorized(override, true);
    expect(override.active).toBe(true);

    // No longer authorized (demoted, or identity went stale): the override is REVOKED
    // (cleared), not merely masked — regaining authority must require a fresh
    // confirmation, matching the acceptance criterion's "revoked" (not "temporarily
    // hidden").
    override = revokeEncounterOverrideIfUnauthorized(override, false);
    expect(override.active).toBe(false);
    expect(encounterActionsBlocked('offline', override)).toBe(true);

    // Idempotent / no-op when there's nothing to revoke.
    expect(revokeEncounterOverrideIfUnauthorized(ENCOUNTER_OVERRIDE_INACTIVE, false)).toBe(ENCOUNTER_OVERRIDE_INACTIVE);
  });

  test('encounterOverrideAuthorized enumerates every precondition in one place (issue #1446, final review round)', () => {
    const base: EncounterOverrideAuthority = { canDmWrite: true, canPlayerWrite: true, staleIdentity: false, campaignId: 1, userId: 42 };
    const granted = confirmEncounterOverride(1, 42);

    // All five preconditions met: authorized.
    expect(encounterOverrideAuthorized(granted, base)).toBe(true);

    // Not active at all: never authorized regardless of authority.
    expect(encounterOverrideAuthorized(ENCOUNTER_OVERRIDE_INACTIVE, base)).toBe(false);

    // 1. canDmWrite RIGHT NOW — a demoted viewer's stored override is unauthorized even
    // though it was validly granted (round 4).
    expect(encounterOverrideAuthorized(granted, { ...base, canDmWrite: false })).toBe(false);

    // 2. !staleIdentity — a cached-identity restore never authorizes the override, no
    // matter who confirmed it or how long the outage has lasted (final review round —
    // membership may be obsolete while staleIdentity is true).
    expect(encounterOverrideAuthorized(granted, { ...base, staleIdentity: true })).toBe(false);

    // 3. Same campaign — an override granted in campaign 1 does not authorize anything in
    // campaign 2 (round 5).
    expect(encounterOverrideAuthorized(granted, { ...base, campaignId: 2 })).toBe(false);

    // 4. Same identity — an override granted for user 42 does not authorize anything for
    // a different signed-in user (round 6).
    expect(encounterOverrideAuthorized(granted, { ...base, userId: 43 })).toBe(false);

    // Every precondition is a hard requirement — failing ANY one of them is enough to
    // deny authorization, not just a majority.
    expect(
      encounterOverrideAuthorized(granted, { canDmWrite: false, canPlayerWrite: false, staleIdentity: true, campaignId: 2, userId: 43 }),
    ).toBe(false);

    // Degenerate case: an override granted with a null userId must NOT authorize against
    // an authority whose userId is also null — `null === null` is true, but an
    // authorization predicate must never default to "match" on two ABSENT identities.
    // canDmWrite would have to also be true for a signed-out/unresolved viewer for this to
    // matter in practice (nothing in this codebase does that today), but the predicate
    // itself must refuse this on its own, not rely on canDmWrite to save it.
    const grantedNullIdentity = confirmEncounterOverride(1, null);
    expect(
      encounterOverrideAuthorized(grantedNullIdentity, { canDmWrite: true, canPlayerWrite: true, staleIdentity: false, campaignId: 1, userId: null }),
    ).toBe(false);
  });

  test('a stale identity blocks the override offer and any already-active override, at every level (issue #1446, final review round)', () => {
    // deriveEncounterSyncState already maps staleIdentity to 'offline' regardless of the
    // transport status underneath it.
    expect(
      deriveEncounterSyncState({ eventStatus: 'connected', readStale: false, resyncPending: false, staleIdentity: true }),
    ).toBe('offline');

    // But an 'offline' reached via staleIdentity must not authorize an override the same
    // way a genuine transport outage does — encounterOverrideAuthorized (the actual
    // authorization gate RunSessionPage composes with the DM-authority check) refuses it
    // outright, independent of state.
    const granted = confirmEncounterOverride(1, 42);
    const staleAuthority: EncounterOverrideAuthority = { canDmWrite: true, canPlayerWrite: true, staleIdentity: true, campaignId: 1, userId: 42 };
    expect(encounterOverrideAuthorized(granted, staleAuthority)).toBe(false);
    expect(revokeEncounterOverrideIfUnauthorized(granted, staleAuthority.canDmWrite && !staleAuthority.staleIdentity).active).toBe(
      false,
    );
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

/**
 * Issue #1914 — the scoped player override. A player has no path to the DM's table-wide
 * "continue anyway", so their own combatant stayed read-only for the whole outage even
 * though the server independently protects HP/death-save/condition writes with CAS. These
 * cover the new `scope` tag, the `gateForWrite` write-class matrix, and — per the explicit
 * warning that this is a shared-state-slot issue — the asymmetric case: `encounterActionsBlocked`
 * (the DM-grade base every OTHER control still composes with) must NOT be satisfied by an
 * active 'own-combatant' override, only by 'dm'.
 */
test.describe('scoped player override (issue #1914)', () => {
  const dmAuthority: EncounterOverrideAuthority = { canDmWrite: true, canPlayerWrite: true, staleIdentity: false, campaignId: 1, userId: 42 };
  const playerAuthority: EncounterOverrideAuthority = { canDmWrite: false, canPlayerWrite: true, staleIdentity: false, campaignId: 1, userId: 7 };

  test('confirmEncounterOverride defaults to dm scope; the player confirm site is the only caller that passes own-combatant', () => {
    expect(confirmEncounterOverride(1, 42)).toMatchObject({ active: true, scope: 'dm' });
    expect(confirmEncounterOverride(1, 42, 'dm')).toMatchObject({ active: true, scope: 'dm' });
    expect(confirmEncounterOverride(1, 7, 'own-combatant')).toMatchObject({ active: true, scope: 'own-combatant' });
  });

  test('encounterOverrideAuthorized: dm scope needs canDmWrite, own-combatant scope needs canPlayerWrite — a player can never obtain the dm scope', () => {
    const dmGrant = confirmEncounterOverride(1, 7, 'dm');
    const ownGrant = confirmEncounterOverride(1, 7, 'own-combatant');

    // A pure player (no DM authority) is never authorized for the dm-scoped grant, even
    // though every OTHER precondition (identity, campaign) matches — canPlayerWrite alone
    // must never substitute for canDmWrite on the dm scope.
    expect(encounterOverrideAuthorized(dmGrant, playerAuthority)).toBe(false);
    // The SAME player IS authorized for the own-combatant-scoped grant.
    expect(encounterOverrideAuthorized(ownGrant, playerAuthority)).toBe(true);

    // The DM is authorized for a dm-scoped grant made FOR them (unchanged from #1446) via
    // canDmWrite — a fresh grant so the campaign/userId tag matches `dmAuthority`.
    const dmGrantForDm = confirmEncounterOverride(dmAuthority.campaignId, dmAuthority.userId, 'dm');
    expect(encounterOverrideAuthorized(dmGrantForDm, dmAuthority)).toBe(true);

    // Every other precondition (staleIdentity, campaign, identity match) still applies
    // identically to the own-combatant scope — it is not a separate, weaker gate.
    expect(encounterOverrideAuthorized(ownGrant, { ...playerAuthority, staleIdentity: true })).toBe(false);
    expect(encounterOverrideAuthorized(ownGrant, { ...playerAuthority, campaignId: 2 })).toBe(false);
    expect(encounterOverrideAuthorized(ownGrant, { ...playerAuthority, userId: 8 })).toBe(false);
    expect(encounterOverrideAuthorized(ownGrant, { ...playerAuthority, canPlayerWrite: false })).toBe(false);
  });

  test('encounterActionsBlocked (the DM-grade base every non-own-combatant control composes with) ignores an active own-combatant override — the asymmetric-gate regression this issue warns about', () => {
    const ownOverride = confirmEncounterOverride(1, 7, 'own-combatant');
    const dmOverride = confirmEncounterOverride(1, 42, 'dm');

    // A same-outage 'own-combatant' override must NOT blanket-unblock the DM-grade gate —
    // next-turn, AoE declare, escalation die, and every other combatant's row all still
    // read this function directly and must stay blocked.
    for (const state of ['offline', 'reconnecting', 'stale', 'connecting'] as const) {
      expect(encounterActionsBlocked(state, ownOverride)).toBe(true);
    }
    // The dm scope keeps unblocking it, exactly as before #1914.
    for (const state of ['offline', 'reconnecting', 'stale', 'connecting'] as const) {
      expect(encounterActionsBlocked(state, dmOverride)).toBe(false);
    }
    // Live is always unblocked regardless of scope.
    expect(encounterActionsBlocked('live', ownOverride)).toBe(false);
  });

  test('gateForWrite: full write-class x ownership x sync-state x override-scope matrix', () => {
    const cases: Array<{
      writeClass: 'turn-topology' | 'own-combatant';
      isOwnCombatant: boolean;
      state: EncounterSyncState;
      override: EncounterOverrideState;
      expectBlocked: boolean;
      label: string;
    }> = [
      // Live: nothing is ever blocked, regardless of class/ownership/override.
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'live', override: ENCOUNTER_OVERRIDE_INACTIVE, expectBlocked: false, label: 'live, own, no override' },
      { writeClass: 'turn-topology', isOwnCombatant: false, state: 'live', override: ENCOUNTER_OVERRIDE_INACTIVE, expectBlocked: false, label: 'live, topology, no override' },

      // Outage, no override: everything blocked regardless of class/ownership.
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'offline', override: ENCOUNTER_OVERRIDE_INACTIVE, expectBlocked: true, label: 'offline, own, no override' },
      { writeClass: 'own-combatant', isOwnCombatant: false, state: 'offline', override: ENCOUNTER_OVERRIDE_INACTIVE, expectBlocked: true, label: 'offline, not-own, no override' },
      { writeClass: 'turn-topology', isOwnCombatant: false, state: 'offline', override: ENCOUNTER_OVERRIDE_INACTIVE, expectBlocked: true, label: 'offline, topology, no override' },

      // Outage, dm override active: EVERYTHING unblocked, regardless of class/ownership —
      // unchanged #1446 behavior.
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'offline', override: confirmEncounterOverride(1, 7, 'dm'), expectBlocked: false, label: 'offline, own, dm override' },
      { writeClass: 'own-combatant', isOwnCombatant: false, state: 'offline', override: confirmEncounterOverride(1, 7, 'dm'), expectBlocked: false, label: 'offline, not-own, dm override' },
      { writeClass: 'turn-topology', isOwnCombatant: false, state: 'offline', override: confirmEncounterOverride(1, 7, 'dm'), expectBlocked: false, label: 'offline, topology, dm override' },

      // Outage, own-combatant override active: ONLY unblocks own-combatant writes on the
      // OWNED row. Everything else — the other combatant's row, and turn-topology — stays
      // blocked exactly as if no override existed at all.
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'offline', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: false, label: 'offline, own, own-combatant override -> UNBLOCKED' },
      { writeClass: 'own-combatant', isOwnCombatant: false, state: 'offline', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: true, label: 'offline, not-own, own-combatant override -> still blocked' },
      { writeClass: 'turn-topology', isOwnCombatant: true, state: 'offline', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: true, label: 'offline, topology (even on own turn), own-combatant override -> still blocked' },
      { writeClass: 'turn-topology', isOwnCombatant: false, state: 'offline', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: true, label: 'offline, topology, own-combatant override -> still blocked' },

      // Same shape across every non-live state (reconnecting / stale / connecting).
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'reconnecting', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: false, label: 'reconnecting, own, own-combatant override -> UNBLOCKED' },
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'stale', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: false, label: 'stale, own, own-combatant override -> UNBLOCKED' },
      { writeClass: 'own-combatant', isOwnCombatant: true, state: 'connecting', override: confirmEncounterOverride(1, 7, 'own-combatant'), expectBlocked: false, label: 'connecting, own, own-combatant override -> UNBLOCKED' },
    ];

    for (const c of cases) {
      expect(gateForWrite(c.writeClass, { isOwnCombatant: c.isOwnCombatant }, c.state, c.override)).toBe(c.expectBlocked);
    }
  });

  test('gateForWrite: end/next/undo turn stays fully blocked for a player even while their own-combatant override is active (acceptance criterion)', () => {
    const ownOverride = confirmEncounterOverride(1, 7, 'own-combatant');
    // Even on the player's OWN turn (isOwnCombatant: true) — turn-topology never reads
    // ownership at all.
    expect(gateForWrite('turn-topology', { isOwnCombatant: true }, 'offline', ownOverride)).toBe(true);
    expect(gateForWrite('turn-topology', { isOwnCombatant: false }, 'offline', ownOverride)).toBe(true);
  });

  test('gateForWrite: an own-combatant override never unblocks a write against a combatant the confirming viewer does not own', () => {
    const ownOverride = confirmEncounterOverride(1, 7, 'own-combatant');
    expect(gateForWrite('own-combatant', { isOwnCombatant: false }, 'offline', ownOverride)).toBe(true);
  });

  test('encounterSyncOverrideBannerKey: own-combatant scope resolves distinct, scoped keys; dm scope (default) is unchanged', () => {
    for (const state of ['offline', 'reconnecting', 'stale'] as const) {
      const dmKey = encounterSyncOverrideBannerKey(state);
      const dmKeyExplicit = encounterSyncOverrideBannerKey(state, 'dm');
      const ownKey = encounterSyncOverrideBannerKey(state, 'own-combatant');
      expect(dmKey).toBe(dmKeyExplicit);
      expect(ownKey).not.toBe(dmKey);
      expect(ownKey).toMatch(/^encounters\.sync\.bannerOverrideOwn/);
    }
    expect(encounterSyncOverrideBannerKey('connecting', 'own-combatant')).toBeNull();
    expect(encounterSyncOverrideBannerKey('live', 'own-combatant')).toBeNull();
  });

  test('own-combatant override is revoked the instant player-write authority is lost, and consumed on stream recovery — same #1446 invariants as the dm scope', () => {
    let override = confirmEncounterOverride(1, 7, 'own-combatant');
    expect(override.active).toBe(true);

    // Settling on every sync-state change is a no-op while still not live.
    override = settleEncounterOverride(override, 'reconnecting');
    expect(override.active).toBe(true);

    // Losing player-write authority (e.g. demoted to spectator) revokes it — mirrors the
    // dm scope's canDmWrite revocation, but keyed to canPlayerWrite instead.
    const revoked = revokeEncounterOverrideIfUnauthorized(
      override,
      encounterOverrideAuthorized(override, { ...playerAuthority, canPlayerWrite: false }),
    );
    expect(revoked.active).toBe(false);

    // A still-authorized own-combatant override is consumed once the stream is live again,
    // exactly like the dm scope (session-scoped to ONE outage, not "forever").
    let stillAuthorized = confirmEncounterOverride(1, 7, 'own-combatant');
    stillAuthorized = settleEncounterOverride(stillAuthorized, 'live');
    expect(stillAuthorized.active).toBe(false);
  });
});
