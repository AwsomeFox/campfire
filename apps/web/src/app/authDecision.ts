/**
 * Pure decision logic for AuthProvider's `/me` handling (issue #579) +
 * restore-safety cache invalidation (issue #723).
 *
 * Extracted from AuthProvider.tsx so the stale-vs-logged-out distinction is
 * unit-testable WITHOUT rendering React, and so the e2e test tsconfig (which
 * doesn't enable JSX) can import it directly. AuthProvider consumes these and
 * applies the decided effect imperatively.
 *
 * #579 in one line: `/me` is excluded from the SW runtime cache (see
 * vite.config.ts), so a successful `/me` is PROVEN-LIVE. We therefore decide
 * what to do from the FETCH OUTCOME alone — never `navigator.onLine`, which
 * reflects the network interface and is exactly the conflation that wiped caches
 * in the original bug.
 *
 * #723 in one line: `/me` now also carries the server's data-generation identity
 * (Me.instance — a per-install UUID + a monotonic generation bumped on every
 * restore). Because `/me` is proven-live, that identity is authoritative. We
 * compare it to the generation the persisted Me snapshot was recorded against:
 * a mismatch means a restore (or an install change) happened since the SW cache
 * was populated, so we wipe the cache exactly the way we do for an account
 * switch. This is what makes a same-ID restore safe — the numeric user/campaign
 * IDs are identical, but the generation token is not.
 */
import type { Me, ServerInstance } from '@campfire/schema';
import { sameDataIdentity } from '../lib/swCache';

/**
 * Outcome of a single `/me` attempt, expressed independent of HOW it failed.
 * This is what {@link decideAuthOutcome} consumes.
 *
 *   - { kind: 'live', me }   proven-live identity (200 OK from a non-cached /me)
 *   - { kind: 'loggedOut' }  proven logged out (real 401, not an offline artifact)
 *   - { kind: 'unreachable' } could not reach the server (network error / non-401).
 *                             NOT logged out.
 */
export type MeFetchOutcome =
  | { kind: 'live'; me: Me }
  | { kind: 'loggedOut' }
  | { kind: 'unreachable' };

/**
 * Inputs to {@link decideAuthOutcome}: the id of the identity active for THIS
 * page session so far (null until a live identity has resolved once), the
 * persisted last-known snapshot (null if none / never persisted), and the
 * in-memory identity carried over from the previous live /me this tab (so a
 * restore detected mid-session — without a reload — also wipes, see #723).
 */
export interface AuthDecisionInputs {
  /** User id of the identity confirmed live this page-session, or null if none yet. */
  currentUserId: number | null;
  /** Last-known Me snapshot persisted from a prior live /me, or null. */
  snapshot: { me: Me; confirmedAt: number; instance?: ServerInstance } | null;
  /**
   * The data-generation identity confirmed live on THIS tab earlier in the
   * session, or null if none (issue #723). When a live /me arrives whose
   * generation differs from this, the cache is wiped even on the SAME user id
   * and even WITHOUT a page reload — a restore mid-session is detected the same
   * way a cross-session restore is. Defaults to null for callers that haven't
   * tracked it (the snapshot's instance still drives the reload-path check).
   */
  currentInstance?: ServerInstance | null;
}

/**
 * The decided effect of a `/me` fetch: what identity (if any) to render, whether
 * it's stale, whether to wipe the caches, and whether to clear / persist the
 * offline snapshot. Kept as data so the React layer applies it imperatively and
 * the pure decision is unit-testable.
 */
export interface AuthDecision {
  /** Identity to render this render. Null = logged out / loading. */
  me: Me | null;
  /** True when `me` came from the persisted snapshot rather than a live /me. */
  staleIdentity: boolean;
  /** Wall-clock ms the rendered identity was last confirmed live, or null. */
  lastSyncedAt: number | null;
  /** True only when caches must be wiped (proven identity/generation change or proven logout). */
  shouldWipeCaches: boolean;
  /** True when the persisted snapshot must be cleared (proven logout). */
  shouldClearSnapshot: boolean;
  /** The identity to persist as the new last-known snapshot, or null to skip. */
  snapshotToPersist: { me: Me; confirmedAt: number; instance: ServerInstance } | null;
  /**
   * True when the fetch could not reach the server (NOT a 401). AuthedLayout
   * surfaces a retry; an offline reload with a snapshot still renders the authed
   * UI (stale) rather than bouncing to /login.
   */
  connectionError: boolean;
}

/**
 * Pure decision: given a `/me` fetch outcome and the current session/snapshot
 * state, produce the effect to apply. This is the heart of the stale-vs-logged-out
 * distinction (issue #579) AND the restore-safety wipe (issue #723), and is
 * deliberately free of any `navigator.onLine` read.
 *
 * Provenance is carried by `outcome.kind` itself: 'live' is ONLY produced from a
 * successful non-cached `/me`, 'loggedOut' ONLY from a real 401, and
 * 'unreachable' ONLY when no identity was obtained. `navigator.onLine` is never
 * consulted because it reflects the network interface, not whether the response
 * came from the server — exactly the conflation that wiped caches in #579.
 *
 * #723 — GENERATION WIPE: in the 'live' branch we ALSO wipe the cache when the
 * live data-generation identity differs from EITHER (a) the persisted snapshot's
 * instance (a restore happened between sessions / page loads) OR (b) the
 * in-memory currentInstance (a restore happened mid-session on this same tab).
 * This is independent of the user-id change check: a restore reuses the same
 * numeric user id, so the id check alone can't catch it — the generation token
 * is the only signal. The wipe reuses the same clearApiCache() path as an
 * account switch (a single SW cache bucket, emptied origin-wide), so a restore
 * invalidates stale bytes exactly the way an account switch does.
 *
 * `now` is injected so tests are deterministic; production passes Date.now().
 */
export function decideAuthOutcome(
  outcome: MeFetchOutcome,
  inputs: AuthDecisionInputs,
  now: number = Date.now(),
): AuthDecision {
  const { currentUserId, snapshot, currentInstance = null } = inputs;

  if (outcome.kind === 'live') {
    const liveId = outcome.me.user.id;
    const liveInstance = outcome.me.instance;
    // A proven-live identity that differs from the one active this session is a
    // real sign-in or account switch — wipe both caches so a prior session's
    // campaign data can never render for this user (issue #268). Same-id reloads
    // (the common case) leave the cache untouched, which is what keeps offline
    // campaign data alive across reloads of the SAME session.
    const identityChanged = currentUserId !== null && currentUserId !== liveId;
    // #723: a restore bumps the server's data generation. If the live generation
    // doesn't match the one the snapshot/current session was recorded against,
    // the SW cache holds responses for the PRE-restore data — wipe. Two checks:
    //   - snapshot.instance mismatch: restore between page loads (the persisted
    //     snapshot recorded the prior generation; a fresh load reads the new one).
    //     Only checked when the snapshot actually CARRIES an instance — a snapshot
    //     absent entirely (true first sign-in) has nothing to invalidate, and a
    //     legacy pre-#723 snapshot (no instance field) is handled by the
    //     currentInstance/session check on tabs that already had one this session.
    //   - currentInstance mismatch: restore mid-session on the same tab (the tab
    //     already confirmed the old generation this session; a polling /me now
    //     reports a new one). Guards the no-reload case.
    const snapshotGenerationChanged =
      snapshot?.instance !== undefined && !sameDataIdentity(snapshot.instance, liveInstance);
    const sessionGenerationChanged = currentInstance !== null && !sameDataIdentity(currentInstance, liveInstance);
    const shouldWipeCaches = identityChanged || snapshotGenerationChanged || sessionGenerationChanged;
    return {
      me: outcome.me,
      staleIdentity: false,
      lastSyncedAt: now,
      shouldWipeCaches,
      shouldClearSnapshot: false,
      snapshotToPersist: { me: outcome.me, confirmedAt: now, instance: liveInstance },
      connectionError: false,
    };
  }

  if (outcome.kind === 'loggedOut') {
    // Proven 401: the session is really gone. Clear everything — caches and the
    // persisted snapshot — so the next sign-in can't inherit this account's data.
    return {
      me: null,
      staleIdentity: false,
      lastSyncedAt: null,
      shouldWipeCaches: true,
      shouldClearSnapshot: true,
      snapshotToPersist: null,
      connectionError: false,
    };
  }

  // unreachable: /me could not reach the server. This is NOT a logout. Restore the
  // persisted last-known identity (if any) flagged stale so the UI can render the
  // authed shell with cached campaign data + an "offline — showing last-known"
  // banner. Critically, the caches are NOT wiped: an offline reload must preserve
  // the very offline-fallback cache the SW exists to provide (#579 regression).
  //
  // #723 note: the generation token from the snapshot is preserved as-is into the
  // rendered (stale) identity, but we do NOT wipe on it here — we couldn't reach
  // the server, so we have no NEW generation to compare against. The next ONLINE
  // /me is what re-validates the generation and wipes if a restore happened.
  return {
    me: snapshot ? snapshot.me : null,
    staleIdentity: snapshot !== null,
    lastSyncedAt: snapshot ? snapshot.confirmedAt : null,
    shouldWipeCaches: false,
    shouldClearSnapshot: false,
    snapshotToPersist: null,
    connectionError: true,
  };
}
