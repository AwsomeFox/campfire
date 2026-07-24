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

/**
 * Issue #798 — reverse-proxy subpath support.
 *
 * `PUBLIC_BASE` is the externally-visible path prefix the SPA is deployed under
 * (e.g. `/campfire` when the public URL is `https://host/campfire/...`). The
 * reverse proxy STRIPS this prefix before forwarding to the server, so all of
 * the server's own routing still sees root-relative paths (`/api/v1/...`) and
 * mostly does NOT need to know about the prefix. Two things DO need it, though:
 *
 *   1. Browser-facing redirects the server emits as bare paths. The OIDC
 *      callback does `res.redirect('/')` on success and
 *      `res.redirect('/login/sso-error')` on failure — under a subpath the
 *      browser would follow that to `https://host/` and lose the prefix,
 *      breaking the SPA load. These must be rewritten to `${PUBLIC_BASE}/`.
 *
 *   2. Cookie `path` scoping. A cookie set with `path: '/api/v1/auth/oidc'` is
 *      only sent on requests whose URL-path starts with `/api/v1/auth/oidc`
 *      FROM THE BROWSER'S POINT OF VIEW. The browser sees
 *      `/campfire/api/v1/auth/oidc/...`, so the flow cookie would never be
 *      sent back. Scoping to `${PUBLIC_BASE}/api/v1/auth/oidc` fixes this; the
 *      session cookie's `path: '/'` already covers everything and needs no
 *      change.
 *
 * Canonicalized to a leading-slash, no-trailing-slash form (except `/` for the
 * root case), so `PUBLIC_BASE=campfire`, `/campfire/`, and `/campfire` all
 * behave identically. `undefined`/empty/`/` all mean "root deployment" and the
 * prefix is exactly `/` — every redirect/cookie path is then unchanged.
 */
export function resolvePublicBase(raw: string | undefined = process.env.PUBLIC_BASE): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '/';
  let pathname = trimmed;
  // Accept a full URL (operator pastes the public origin) by keeping only the
  // pathname — PUBLIC_BASE is a path, never an origin. Only an explicit
  // http(s):// scheme is parsed as a URL; a protocol-relative `//host/path` is
  // intentionally treated as a PATH (the leading-// is collapsed by the
  // normalize step below) because distinguishing `//host/path` (URL) from
  // `//path` (typo'd path) is unreliable, and an operator who means a URL will
  // write the scheme.
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    // leave pathname as-is
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return pathname === '' ? '/' : pathname;
}

/**
 * Whether the deployment is under a non-root subpath (issue #798). Convenience
 * for code that only needs to branch on "is a prefix configured at all".
 */
export function hasPublicBase(): boolean {
  return resolvePublicBase() !== '/';
}

/**
 * Prefix a bare path with the public base for a browser-facing redirect or
 * cookie path (issue #798). The input is expected to start with `/`. Root
 * deployments return the path unchanged.
 *
 *   joinPublicBase('/')                     with `/campfire` -> `/campfire/`
 *   joinPublicBase('/login/sso-error')      with `/campfire` -> `/campfire/login/sso-error`
 *   joinPublicBase('/api/v1/auth/oidc')     with `/campfire` -> `/campfire/api/v1/auth/oidc`
 *   joinPublicBase('/anything')             with `/`         -> `/anything`
 */
export function joinPublicBase(path: string): string {
  const base = resolvePublicBase();
  if (base === '/') return path;
  if (path === '/') return `${base}/`;
  if (path.startsWith('/')) return `${base}${path}`;
  return `${base}/${path}`;
}
