/**
 * Deploy/security env resolution shared across bootstrap (main.ts), the session
 * auth guard, and the session-cookie controllers. Kept in one place (and unit
 * tested — see test/unit/security-config.spec.ts) so the several call sites that
 * key off `NODE_ENV` / the deploy flags below can't drift apart.
 */

/**
 * Coerce the `TRUST_PROXY` env value into what Express's `app.set('trust proxy', …)`
 * actually expects (issue #165). Env vars are always strings, but Express treats a
 * STRING as an IP/subnet allow-list and only a NUMBER as a hop count — so passing the
 * raw string `"2"` silently disables trust (it's read as the IP literal "2", never
 * matched), and `"true"` throws `invalid IP address: true` at boot.
 *
 *  - unset            -> `1` (trust exactly one hop — the reference Traefik deployment)
 *  - all-digits       -> Number (a real hop count: `"2"` -> `2`)
 *  - `"true"`/`"false"` (any case) -> boolean
 *  - anything else    -> passed through unchanged (an explicit IP/subnet list, which
 *                        Express supports natively, e.g. `"127.0.0.1,10.0.0.0/8"`)
 */
export function resolveTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined) return 1;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return trimmed;
}

/**
 * Plain-HTTP LAN escape hatch (issue #117). When set, an operator running without TLS
 * (the canonical homelab case `http://192.168.1.x:8080`) gets a working app:
 *  (a) helmet drops CSP `upgrade-insecure-requests` + HSTS (which otherwise force the
 *      browser to rewrite every subresource/`/api` call to `https://…` where nothing
 *      listens), and
 *  (b) the session cookie is issued non-`Secure` (a `Secure` cookie is silently dropped
 *      over plain HTTP, so login 200s but the next request is 401 — a login loop).
 *
 * Default (unset) is unchanged: secure production behavior.
 */
export function resolveAllowInsecureHttp(): boolean {
  const raw = process.env.ALLOW_INSECURE_HTTP?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Whether session/flow cookies should carry the `Secure` attribute. Secure in
 * production, EXCEPT when the operator has opted into plain-HTTP serving via
 * ALLOW_INSECURE_HTTP (see above). Outside production, non-secure as before.
 */
export function resolveCookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' && !resolveAllowInsecureHttp();
}

/**
 * Whether the DEV_AUTH bypass (uncredentialed request -> synthetic server-admin, for
 * e2e tests) is active (issue #119). Hard-gated OFF in production regardless of the
 * flag: DEV_AUTH ships in the production image, and an operator who copies `DEV_AUTH=1`
 * from an old compose snippet must NOT thereby open every endpoint to anonymous admin.
 */
export function isDevAuthActive(): boolean {
  return process.env.DEV_AUTH === '1' && process.env.NODE_ENV !== 'production';
}
