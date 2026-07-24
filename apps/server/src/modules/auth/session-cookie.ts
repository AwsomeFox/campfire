import { resolveCookieSecure } from '../../common/security-config';
import { SESSION_MAX_AGE_MS } from './auth.constants';

/**
 * Options for the `campfire_session` cookie. Shared by login/setup/signup,
 * OIDC callback, invite accept, and SessionAuthGuard (which re-issues the
 * cookie when a sliding session touch extends `expiresAt` — issue #661).
 *
 * @param maxAgeMs Cookie lifetime in ms. Defaults to the idle window. When the
 *   guard re-issues after a slide, pass remaining time until the (possibly
 *   absolute-capped) server `expiresAt` so browser Max-Age cannot outlive the DB.
 */
export function sessionCookieOptions(maxAgeMs: number = SESSION_MAX_AGE_MS) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.max(0, maxAgeMs),
    // Secure in production, unless the operator opted into plain-HTTP serving
    // (ALLOW_INSECURE_HTTP) — a Secure cookie is silently dropped over plain HTTP,
    // causing a login loop on a no-TLS homelab deployment (issue #117 / #525).
    secure: resolveCookieSecure(),
  };
}
