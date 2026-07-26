/**
 * Ambiguous-outcome classification and the reconciliation gate (issue #580).
 *
 * An idempotency key stops a retry from double-applying, but it does not tell the human
 * what happened. After a write times out or the socket drops, the DM is looking at a
 * screen whose optimistic HP may or may not match the server, and their instinct is to
 * click again — which, with a NEW key, is a genuinely new intent and genuinely double
 * damage. So the ambiguous case has to (a) say so, and (b) hold the controls until the
 * client has re-read committed state.
 *
 * Kept as pure functions over an explicit state so the behavior is testable without a
 * browser: the component owns the `useState`, this module owns the rules.
 */
import { ApiError, isAmbiguousMutation } from './api';

/**
 * Did this failure leave the outcome genuinely unknown?
 *
 * Unknown: a mutation timeout (the request may have been applied server-side), and any
 * network-layer failure with no HTTP status at all — a dropped socket after the server
 * committed looks identical to one dropped before it ever arrived.
 *
 * Known-failed: any HTTP status. Even a 502/504 from a proxy is ambiguous in principle,
 * so it counts as unknown too — the proxy may be reporting a backend that already
 * committed. A 4xx is the one genuinely safe "nothing happened" answer.
 */
export function isAmbiguousOutcome(error: unknown): boolean {
  if (isAmbiguousMutation(error)) return true;
  if (error instanceof ApiError) {
    // 502/503/504 are gateway-level: the request may have reached (and been applied by)
    // the backend before the proxy gave up. 4xx and other 5xx were produced by the app
    // itself, which means it decided — nothing committed.
    return error.status === 502 || error.status === 503 || error.status === 504;
  }
  // No status at all: a TypeError from fetch, an ECONNRESET, an offline drop.
  return error instanceof Error;
}

/** The gate's state machine. `checking` is the state that blocks further actions. */
export type ReconcileState =
  | { phase: 'idle' }
  | { phase: 'checking'; since: number }
  | { phase: 'reconciled'; since: number };

export const IDLE_RECONCILE: ReconcileState = { phase: 'idle' };

/**
 * Enter the checking phase after an ambiguous failure. Idempotent: a second ambiguous
 * failure while already checking does not restart the clock, so a burst of failed HP
 * clicks produces one reconciliation, not one per click.
 */
export function beginReconcile(state: ReconcileState, now: number): ReconcileState {
  if (state.phase === 'checking') return state;
  return { phase: 'checking', since: now };
}

/**
 * Committed state has been re-read. Moves to `reconciled`, which unblocks the controls
 * while leaving a short-lived "we checked" acknowledgement for the UI to show.
 */
export function completeReconcile(state: ReconcileState, now: number): ReconcileState {
  if (state.phase !== 'checking') return state;
  return { phase: 'reconciled', since: now };
}

/** Dismiss the acknowledgement (or reset after a successful action). */
export function clearReconcile(): ReconcileState {
  return IDLE_RECONCILE;
}

/**
 * Whether a further non-idempotent action must be refused right now. This is the actual
 * acceptance criterion — "reconcile before another action is allowed" — expressed as one
 * predicate every combat control consults, rather than as per-button ad-hoc disabling.
 */
export function blocksFurtherActions(state: ReconcileState): boolean {
  return state.phase === 'checking';
}
