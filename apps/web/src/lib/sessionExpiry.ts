/**
 * Provenance-safe session-expiry signal (issue #885).
 *
 * A sleeping tab can learn the cookie is gone from ANY same-origin API or SSE
 * response — not only from AuthProvider's periodic `/me` refresh. This module is
 * the single fan-out point:
 *
 *   - Only a real HTTP 401 signals expiry (network failures stay "offline"/unreachable).
 *   - Campaign-scoped 403s are NOT expiry — streams stop without clearing identity.
 *   - Auth challenge endpoints (login/token/…) emit 401 as a normal rejection and
 *     must not be treated as "session expired".
 *
 * AuthProvider subscribes and clears identity-scoped state when a prior live
 * session existed. After reauth, {@link resetSessionExpiredSignal} bumps a resume
 * epoch so SSE hooks that stopped on 401 reopen.
 */

type Listener = () => void;

let expired = false;
let resumeEpoch = 0;
const expiredListeners = new Set<Listener>();
const resumeListeners = new Set<Listener>();

/**
 * Paths where the server uses 401 as a credentials / challenge answer rather
 * than "your existing session died". Matching is pathname-only (no query).
 */
export function isAuthChallengePath(pathname: string): boolean {
  if (pathname === '/api/v1/auth/login') return true;
  if (pathname === '/api/v1/auth/token') return true;
  if (pathname === '/api/v1/auth/signup') return true;
  if (pathname.startsWith('/api/v1/auth/oidc/')) return true;
  return false;
}

/** Best-effort pathname from a request URL (absolute or root-relative). */
export function requestPathname(url: string): string {
  try {
    return new URL(url, 'http://local.invalid').pathname;
  } catch {
    return url;
  }
}

/**
 * Classify an SSE connect HTTP status for the reconnect loop.
 *   - `session-expired` — proven 401; signal + stop (retrying won't help until reauth)
 *   - `forbidden`       — campaign/feature 403; stop without clearing the session
 *   - `other`           — caller decides (retry / throw)
 */
export function classifyStreamConnectStatus(
  status: number,
): 'session-expired' | 'forbidden' | 'other' {
  if (status === 401) return 'session-expired';
  if (status === 403) return 'forbidden';
  return 'other';
}

/** True after {@link signalSessionExpired} until {@link resetSessionExpiredSignal}. */
export function isSessionExpiredSignaled(): boolean {
  return expired;
}

/**
 * Record a provenance-safe 401. Idempotent until reset — a burst of failing
 * requests (encounter + upload + AI) must not thrash AuthProvider.
 */
export function signalSessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const listener of expiredListeners) listener();
}

/**
 * Notify AuthProvider (and tests) when a proven 401 arrives. Returns an
 * unsubscribe function.
 */
export function subscribeSessionExpired(listener: Listener): () => void {
  expiredListeners.add(listener);
  return () => {
    expiredListeners.delete(listener);
  };
}

/**
 * Clear the latched expiry flag and bump the resume epoch so SSE subscriptions
 * that exited on 401 reopen after login. No-op when nothing was signaled.
 */
export function resetSessionExpiredSignal(): void {
  if (!expired) return;
  expired = false;
  resumeEpoch += 1;
  for (const listener of resumeListeners) listener();
}

/** Monotonic counter bumped on each successful reauth after an expiry signal. */
export function getSessionResumeEpoch(): number {
  return resumeEpoch;
}

/** Subscribe to resume-epoch changes (for `useSyncExternalStore` in SSE hooks). */
export function subscribeSessionResume(onStoreChange: Listener): () => void {
  resumeListeners.add(onStoreChange);
  return () => {
    resumeListeners.delete(onStoreChange);
  };
}

/**
 * If `status` is a proven 401 on a non-challenge path, latch the expiry signal.
 * Network failures never reach here (no HTTP status).
 */
export function noteUnauthorizedResponse(url: string, status: number): void {
  if (status !== 401) return;
  if (isAuthChallengePath(requestPathname(url))) return;
  signalSessionExpired();
}

/** Test-only: restore module latches between specs. */
export function __resetSessionExpiryForTests(): void {
  expired = false;
  resumeEpoch = 0;
  expiredListeners.clear();
  resumeListeners.clear();
}
