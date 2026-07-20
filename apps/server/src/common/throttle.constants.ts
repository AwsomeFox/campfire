/**
 * Rate limiting (P2 DoS fix): @Public auth endpoints (POST /auth/login,
 * /auth/token, /auth/setup) run a full scrypt password hash/verify (~30ms of
 * CPU) per request, unauthenticated, unbounded — a trivial DoS vector against
 * an otherwise cheap-to-serve API. @nestjs/throttler is wired in globally
 * (see AppModule) with a loose default limit everywhere, and a much stricter
 * per-IP limit applied directly to the three auth routes via @Throttle(...).
 *
 * The tracker is IP-based (ThrottlerGuard's default `req.ip`), which respects
 * Express's `trust proxy` setting — enabled in main.ts's configureApp() so
 * this reads the real client IP from X-Forwarded-For behind the Traefik
 * reverse proxy in production, rather than bucketing every request under
 * Traefik's own IP.
 */

/** Named throttler config keys, matching ThrottlerModule.forRoot()'s `throttlers[].name`. */
export const THROTTLE_DEFAULT = 'default';
export const THROTTLE_AUTH = 'auth';
export const THROTTLE_SHARE = 'share';

/** Loose default: normal API usage (including MCP tool-call bursts) should never realistically hit this. */
export const DEFAULT_THROTTLE_LIMIT = 300;
export const DEFAULT_THROTTLE_TTL_MS = 60_000;

/** Strict: login/token/setup — 10 attempts/minute/IP is generous for a real user, punishing for a scrypt-DoS script. */
export const AUTH_THROTTLE_LIMIT = 10;
export const AUTH_THROTTLE_TTL_MS = 60_000;

/**
 * Strict-ish: GET /shared/recaps/:token (public read-only recap share links).
 * The lookup itself is cheap (one sha256 + one indexed SELECT) and tokens are
 * 192-bit unguessable, so this is defense-in-depth against enumeration scripts
 * and unauthenticated hammering rather than a CPU guard — 30/minute/IP is
 * plenty for a shared link opened by real people.
 */
export const SHARE_THROTTLE_LIMIT = 30;
export const SHARE_THROTTLE_TTL_MS = 60_000;

/**
 * Strict-ish: the public ICS calendar feed (GET /calendar/:token.ics) is
 * unauthenticated by design (capability-URL secret, see crypto.ts
 * generateIcsFeedToken). Real calendar clients poll at most every few
 * minutes; 30/min/IP is generous for them and shuts down token-guessing or
 * scrape floods. Applied per-route via @Throttle({auth: {...}}) reusing the
 * `auth` named throttler — ThrottlerGuard keys counters per route+IP, so this
 * bucket never interferes with the login/token/setup counters.
 */
export const ICS_THROTTLE_LIMIT = 30;
export const ICS_THROTTLE_TTL_MS = 60_000;

/**
 * Test-env escape hatch: e2e suites legitimately fire many rapid auth calls
 * across a single jest file (e.g. auth.e2e-spec.ts's ~28 login/setup calls in
 * one run) — real per-test-file throttling would make those suites flaky
 * rather than testing anything meaningful. Sibling to the existing DEV_AUTH
 * env-gate pattern (see session-auth.guard.ts). Sets are opt-in: only
 * test/test-app.ts's helpers set THROTTLE_DISABLED=1; the dedicated
 * throttle.e2e-spec.ts suite explicitly unsets it to exercise the real path.
 */
export function isThrottleDisabled(): boolean {
  return process.env.THROTTLE_DISABLED === '1';
}
