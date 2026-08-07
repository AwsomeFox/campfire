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
 * Session-scoped "continue anyway" override (issue #1446, scoped by issue #1914). `active`
 * unblocks conflict-prone actions while the sync state is not `live`; it is granted only by
 * an explicit confirmation ({@link confirmEncounterOverride}) and consumed the moment the
 * stream is `live` again ({@link settleEncounterOverride}), so a later, separate outage
 * prompts again rather than silently sailing through.
 *
 * The active variant carries the (campaignId, userId) it was granted FOR (final #1446 review
 * round): that tag is one of the preconditions {@link encounterOverrideAuthorized} checks
 * directly, rather than relying solely on a separate reset effect to have already cleared a
 * cross-campaign or cross-identity override before anything reads `.active`.
 *
 * `scope` (issue #1914) is the SAME kind of tag, one level finer:
 * - `'dm'` is the original, table-wide override — once authorized it unblocks every
 *   conflict-prone write ({@link encounterActionsBlocked} returns `false` outright).
 * - `'own-combatant'` is a player's own acknowledgement — it authorizes ONLY writes to the
 *   combatant THEY own (see {@link gateForWrite}); turn-topology writes (end/next/undo turn)
 *   and any other combatant's state stay blocked exactly as if no override existed at all.
 * A player has no path that constructs a `'dm'`-scoped override (see
 * {@link encounterOverrideAuthorized}, which requires `canDmWrite` for that scope alone), and
 * an `'own-combatant'` override held by anyone never widens past the one combatant it names
 * implicitly via ownership at read time — it carries no combatant id of its own because
 * {@link gateForWrite} always re-checks CURRENT ownership of the row being written, not a
 * snapshot taken at confirm time.
 */
export type EncounterOverrideScope = 'dm' | 'own-combatant';

export type EncounterOverrideState =
  | { active: false }
  | { active: true; scope: EncounterOverrideScope; campaignId: number; userId: number | null };

export const ENCOUNTER_OVERRIDE_INACTIVE: EncounterOverrideState = { active: false };

/**
 * Grant the override — call this from the "Continue anyway" confirmation. `scope` defaults
 * to `'dm'` so every existing DM call site (source-compatible per issue #1914's sketch) keeps
 * granting the original table-wide override without passing anything new; the player-facing
 * "own combatant" confirm is the only caller that passes `'own-combatant'` explicitly.
 */
export function confirmEncounterOverride(
  campaignId: number,
  userId: number | null,
  scope: EncounterOverrideScope = 'dm',
): EncounterOverrideState {
  return { active: true, scope, campaignId, userId };
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
 * Revoke a granted override the instant it is no longer authorized (issue #1446 review
 * fixes, rounds 4 and final): the override is a DM decision made against a specific,
 * freshly-confirmed identity, and a viewer who is demoted mid-outage, or whose identity
 * goes stale (see {@link EncounterOverrideAuthority.staleIdentity}), must not keep acting
 * on an acknowledgement they no longer have standing to have made. `authorized` going
 * false has to actually clear the flag, not just hide the confirm affordance, or a
 * disqualified viewer's owned-combatant mutations stay unblocked. Idempotent (returns the
 * same reference) when there is nothing to revoke. Pass
 * `authority.canDmWrite && !authority.staleIdentity` (or route through
 * {@link encounterOverrideAuthorized} entirely — see that function's doc for why campaign/
 * identity match is checked separately, at read time, rather than here).
 */
export function revokeEncounterOverrideIfUnauthorized(
  override: EncounterOverrideState,
  authorized: boolean,
): EncounterOverrideState {
  if (!authorized && override.active) return ENCOUNTER_OVERRIDE_INACTIVE;
  return override;
}

/**
 * Whether the "Continue anyway" affordance should be offered at all: not while
 * live (nothing to override), and not during the initial connecting grace period
 * (a genuine sub-second cold connect should just block quietly, not prompt). Campaign/
 * identity match ({@link EncounterOverrideAuthority}) is not a precondition of the OFFER —
 * there is nothing to compare against before the override exists — it is tagged from the
 * current context the instant confirmation grants it, so it is satisfied by construction.
 */
export function encounterOverrideOfferable(state: EncounterSyncState): boolean {
  return state !== 'live' && state !== 'connecting';
}

/**
 * Everything the "continue anyway" override needs to actually authorize a mutation right
 * now (issue #1446, final review round — five prior rounds each found a different
 * transition that silently satisfied some of these and bypassed one):
 *   - `canDmWrite`    — DM write authority RIGHT NOW, not merely when confirmed (round 4).
 *                       Required for `scope: 'dm'` only.
 *   - `canPlayerWrite`— write authority for the signed-in campaign membership RIGHT NOW
 *                       (issue #1914). Required for `scope: 'own-combatant'` only — this is
 *                       deliberately NOT `canDmWrite`'s player-side sibling checked for both
 *                       scopes; a `'dm'`-scoped override still requires `canDmWrite`
 *                       specifically, so a demoted-to-player former DM cannot keep acting on
 *                       an override that was only ever valid for the DM-grade scope.
 *   - `staleIdentity` — true while AuthProvider is showing a cached identity restored
 *                       after a failed `/me` (its documented contract: membership may be
 *                       obsolete). The override is neither offerable nor valid while this
 *                       is true, however long the outage has lasted or who confirmed it.
 *   - `campaignId` / `userId` — the CURRENT campaign and signed-in user, compared against
 *                       the override's own stored tag (rounds 5–6: a cross-campaign or
 *                       cross-identity carry-over is a leaked trust decision, not a mere
 *                       staleness bug).
 */
export type EncounterOverrideAuthority = {
  canDmWrite: boolean;
  canPlayerWrite: boolean;
  staleIdentity: boolean;
  campaignId: number;
  userId: number | null;
};

/**
 * THE single gate for whether an override authorizes anything: every precondition named
 * above, ANDed together in one place so a reader sees the full set at a glance and a
 * future change cannot add a transition that bypasses just one of them. Evaluated
 * identically whether the override was JUST granted (its tag is set from this same
 * `authority` context, so the campaign/identity checks hold trivially) or has been active
 * for a while (all preconditions re-checked on every render) — the round-4 (#1446) finding
 * (an override survived a mid-outage demotion) was exactly two different moments where a
 * stale answer went unchecked, and this function is the fix for both at once.
 *
 * Issue #1914: the scope-specific write-authority check (`canDmWrite` for `'dm'`,
 * `canPlayerWrite` for `'own-combatant'`) is the ONLY place that differs by scope — every
 * other precondition (identity freshness, campaign match, identity match) applies
 * identically to both, so a player can never obtain the `'dm'` scope by any path that
 * satisfies `canPlayerWrite` alone.
 */
export function encounterOverrideAuthorized(
  override: EncounterOverrideState,
  authority: EncounterOverrideAuthority,
): boolean {
  if (!override.active || authority.staleIdentity) return false;
  if (override.campaignId !== authority.campaignId) return false;
  // Issue #1446 review fix: `override.userId === authority.userId` alone would authorize
  // when BOTH are `null` (two absent identities "matching") — an authorization predicate
  // should never default to true on an absent identity. Require a real, non-null match.
  if (override.userId == null || authority.userId == null || override.userId !== authority.userId) return false;
  return override.scope === 'dm' ? authority.canDmWrite : authority.canPlayerWrite;
}

/**
 * THE DM-grade action gate: conflict-prone mutations are blocked unless the stream is live
 * OR the DM has confirmed the table-wide override for this outage. `override` should
 * already reflect current authorization (see {@link encounterOverrideAuthorized}) — this
 * function does not itself take authority params so it stays a pure two-input gate
 * composable with the existing permission checks callers already run.
 *
 * Issue #1914: deliberately scope-gated to `'dm'` — an active `'own-combatant'` override
 * does NOT unblock here. This is the base every turn-topology / DM-only control still
 * composes with unchanged (a DM's override behaves exactly as it did before this issue);
 * {@link gateForWrite} is the only place a same-outage `'own-combatant'` override can
 * additionally relax anything, and only for the one combatant it names by ownership.
 * Splitting this check out (rather than adding an ownership guard to a shared "is anything
 * overridden" flag) is what keeps a player's own-combatant confirmation from silently
 * unblocking next-turn, AoE declaration, or any other combatant's row.
 */
export function encounterActionsBlocked(state: EncounterSyncState, override: EncounterOverrideState): boolean {
  return encounterRiskyActionsBlocked(state) && !(override.active && override.scope === 'dm');
}

/**
 * Issue #1914 — the two write shapes the "continue anyway" flow now distinguishes:
 *   - `'turn-topology'`: end/next/undo turn. Only ever unblocked by the `'dm'` scope —
 *     ownership is irrelevant, so passing `isOwnCombatant: true` here changes nothing.
 *   - `'own-combatant'`: own HP/temp HP, own death saves, own conditions, own turn-state
 *     declarations. Unblocked by the `'dm'` scope (unchanged) OR by a same-outage
 *     `'own-combatant'` scope override, but ONLY when `ownership.isOwnCombatant` is true
 *     for the specific row/write being gated.
 */
export type EncounterWriteClass = 'turn-topology' | 'own-combatant';

export type EncounterWriteOwnership = {
  /** True when the write targets the combatant the ACTING viewer owns right now. */
  isOwnCombatant: boolean;
};

/**
 * THE write-class gate (issue #1914): composes {@link encounterActionsBlocked} (the
 * DM-grade base, unchanged) with the finer-grained `'own-combatant'` relaxation. Always at
 * least as strict as `encounterActionsBlocked` — the only way this returns `false` where
 * that returns `true` is `writeClass === 'own-combatant'`, `ownership.isOwnCombatant` is
 * true, AND `override.scope === 'own-combatant'` is itself active, so an `'own-combatant'`
 * override granted by one player can never read as unblocking `'turn-topology'` writes or
 * any OTHER combatant's row, no matter how the call site is wired.
 *
 * `override` must already be authorization-checked (see {@link encounterOverrideAuthorized})
 * exactly like `encounterActionsBlocked` requires — this stays a pure gate over its four
 * inputs, composable with whatever mount/permission checks a caller already runs.
 */
export function gateForWrite(
  writeClass: EncounterWriteClass,
  ownership: EncounterWriteOwnership,
  state: EncounterSyncState,
  override: EncounterOverrideState,
): boolean {
  if (!encounterActionsBlocked(state, override)) return false;
  if (writeClass === 'own-combatant' && ownership.isOwnCombatant) {
    return !(override.active && override.scope === 'own-combatant');
  }
  return true;
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
 *
 * `scope` (issue #1914, defaults to `'dm'` so every existing call site stays
 * source-compatible) selects the `'own-combatant'` variant, whose copy must not claim
 * combat at large is unblocked — only the owning player's own combatant is — the same
 * "no false claim" requirement the base override banner exists for, one scope narrower.
 */
export function encounterSyncOverrideBannerKey(
  state: EncounterSyncState,
  scope: EncounterOverrideScope = 'dm',
): string | null {
  const own = scope === 'own-combatant';
  switch (state) {
    case 'offline':
      return own ? 'encounters.sync.bannerOverrideOwnOffline' : 'encounters.sync.bannerOverrideOffline';
    case 'reconnecting':
      return own ? 'encounters.sync.bannerOverrideOwnReconnecting' : 'encounters.sync.bannerOverrideReconnecting';
    case 'stale':
      return own ? 'encounters.sync.bannerOverrideOwnStale' : 'encounters.sync.bannerOverrideStale';
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
