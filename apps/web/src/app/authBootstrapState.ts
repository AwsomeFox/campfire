/**
 * Pure bootstrap-surface helpers for first-run / cold-load recovery (issue #801).
 *
 * The bug: AuthStatusGate fetched GET /auth/status without modeling failure, and
 * AuthedLayout's Retry only re-fetched /me. On a fresh (or briefly unreachable)
 * server the expected 401 from /me cleared the connection error and bounced the
 * operator to Sign in while setupRequired was still unknown — until a full reload.
 *
 * These helpers classify:
 *   - auth status as loading | success | error
 *   - the authed-subtree gate as splash | recovery | setup | login | authed
 *   - public auth screens (login/setup) as loading | recovery | setup | ready
 *
 * Kept free of React/DOM so the e2e unit suite can pin the acceptance matrix
 * without mounting providers.
 */

/** Phase of the GET /auth/status bootstrap promise. */
export type AuthStatusPhase = 'loading' | 'success' | 'error';

/**
 * Derive the auth-status phase from provider flags.
 *
 * `error` wins over a leftover `status` so a failed refresh is never mistaken
 * for a known configured/fresh answer. A settled fetch with neither status nor
 * error (the pre-#801 hole) is treated as error — status is unknown.
 */
export function authStatusPhase(input: {
  loading: boolean;
  status: unknown | null;
  error: boolean;
}): AuthStatusPhase {
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (input.status != null) return 'success';
  return 'error';
}

/** Where AuthedLayout should land after both bootstrap promises settle. */
export type AuthedBootstrapSurface = 'splash' | 'recovery' | 'setup' | 'login' | 'authed';

/**
 * Authed-subtree gate. Does not choose setup vs login until /auth/status is
 * known. A /me connection error OR a status error with no identity shares one
 * recovery surface. A restored stale identity (#579) is allowed through even
 * when status failed, so offline reload is not blocked on /auth/status.
 */
export function authedBootstrapSurface(input: {
  statusPhase: AuthStatusPhase;
  setupRequired: boolean;
  meReady: boolean;
  hasMe: boolean;
  connectionError: boolean;
}): AuthedBootstrapSurface {
  if (input.statusPhase === 'loading' || !input.meReady) return 'splash';

  if (!input.hasMe) {
    if (input.statusPhase === 'error' || input.connectionError) return 'recovery';
    if (input.setupRequired) return 'setup';
    return 'login';
  }

  // Authenticated (live or stale). setupRequired with a session is rare; keep
  // the existing redirect so a half-configured install cannot open the hub.
  if (input.setupRequired) return 'setup';
  return 'authed';
}

/** /login before the Sign-in form is safe to show. */
export type LoginBootstrapSurface = 'loading' | 'recovery' | 'setup' | 'form';

/** /login: wait for status; recover on error; bounce to setup when fresh. */
export function loginBootstrapSurface(input: {
  statusPhase: AuthStatusPhase;
  setupRequired: boolean;
}): LoginBootstrapSurface {
  if (input.statusPhase === 'loading') return 'loading';
  if (input.statusPhase === 'error') return 'recovery';
  if (input.setupRequired) return 'setup';
  return 'form';
}

/** /setup before the first-admin form is safe to show. */
export type SetupBootstrapSurface = 'loading' | 'recovery' | 'form' | 'redirect';

/** /setup: wait for status; recover on error; form only while setupRequired. */
export function setupBootstrapSurface(input: {
  statusPhase: AuthStatusPhase;
  setupRequired: boolean;
}): SetupBootstrapSurface {
  if (input.statusPhase === 'loading') return 'loading';
  if (input.statusPhase === 'error') return 'recovery';
  if (input.setupRequired) return 'form';
  // Configured: caller redirects to / or /login once identity is ready.
  return 'redirect';
}

/**
 * Retry both bootstrap promises together. Order is not significant; either
 * failure leaves its own error flag for the next surface classification.
 * Does not throw — status refresh returns false on failure, and /me refresh
 * records connectionError on the auth context.
 */
export async function retryAuthBootstrap(
  refreshStatus: () => Promise<unknown>,
  refreshMe: () => Promise<unknown>,
): Promise<void> {
  await Promise.all([
    Promise.resolve(refreshStatus()).catch(() => {}),
    Promise.resolve(refreshMe()).catch(() => {}),
  ]);
}
