/**
 * Pure decision logic for AuthProvider's `/me` handling (issue #579).
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
 */
import type { Me } from '@campfire/schema';

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
 * page session so far (null until a live identity has resolved once), and the
 * persisted last-known snapshot (null if none / never persisted).
 */
export interface AuthDecisionInputs {
  /** User id of the identity confirmed live this page-session, or null if none yet. */
  currentUserId: number | null;
  /** Last-known Me snapshot persisted from a prior live /me, or null. */
  snapshot: { me: Me; confirmedAt: number } | null;
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
  /** True only when caches must be wiped (proven identity change or proven logout). */
  shouldWipeCaches: boolean;
  /** True when the persisted snapshot must be cleared (proven logout). */
  shouldClearSnapshot: boolean;
  /** The identity to persist as the new last-known snapshot, or null to skip. */
  snapshotToPersist: { me: Me; confirmedAt: number } | null;
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
 * distinction (issue #579) and is deliberately free of any `navigator.onLine` read.
 *
 * Provenance is carried by `outcome.kind` itself: 'live' is ONLY produced from a
 * successful non-cached `/me`, 'loggedOut' ONLY from a real 401, and
 * 'unreachable' ONLY when no identity was obtained. `navigator.onLine` is never
 * consulted because it reflects the network interface, not whether the response
 * came from the server — exactly the conflation that wiped caches in #579.
 *
 * `now` is injected so tests are deterministic; production passes Date.now().
 */
export function decideAuthOutcome(
  outcome: MeFetchOutcome,
  inputs: AuthDecisionInputs,
  now: number = Date.now(),
): AuthDecision {
  const { currentUserId, snapshot } = inputs;

  if (outcome.kind === 'live') {
    const liveId = outcome.me.user.id;
    // A proven-live identity that differs from the one active this session is a
    // real sign-in or account switch — wipe both caches so a prior session's
    // campaign data can never render for this user (issue #268). Same-id reloads
    // (the common case) leave the cache untouched, which is what keeps offline
    // campaign data alive across reloads of the SAME session.
    const identityChanged = currentUserId !== null && currentUserId !== liveId;
    return {
      me: outcome.me,
      staleIdentity: false,
      lastSyncedAt: now,
      shouldWipeCaches: identityChanged,
      shouldClearSnapshot: false,
      snapshotToPersist: { me: outcome.me, confirmedAt: now },
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
