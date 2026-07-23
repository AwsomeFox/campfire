import { resolveCookieSecure } from '../../common/security-config';
import { SESSION_MAX_AGE_MS } from './auth.constants';

/**
 * Options for the `campfire_session` cookie. Shared by login/setup/signup,
 * OIDC callback, invite accept, and SessionAuthGuard (which re-issues the
 * cookie when a sliding session touch extends `expiresAt` — issue #661).
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
    // Secure in production, unless the operator opted into plain-HTTP serving
    // (ALLOW_INSECURE_HTTP) — a Secure cookie is silently dropped over plain HTTP,
    // causing a login loop on a no-TLS homelab deployment (issue #117 / #525).
    secure: resolveCookieSecure(),
  };
}
