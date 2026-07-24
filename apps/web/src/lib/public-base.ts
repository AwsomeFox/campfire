/**
 * Reverse-proxy subpath support (issue #798).
 *
 * A single build-time setting — `PUBLIC_BASE` — drives every path the SPA
 * emits: Vite's `base` (asset/chunk URLs), the router's `basename`, the API
 * client prefix, the PWA manifest's `scope`/`start_url`, and the service
 * worker's navigate-fallback / deny patterns. Root deployments (the default)
 * leave everything exactly as it was: the prefix is `/`.
 *
 * The proxy contract:
 *
 *  - The reverse proxy TERMINATES a path like `https://host/campfire/...` and
 *    FORWARDS to this origin AFTER STRIPPING the prefix. From the server's
 *    point of view every request still arrives at `/api/v1/...`, `/healthz`,
 *    `/`, etc. — that's why nothing inside Nest changes its routing.
 *  - The browser, though, only knows `https://host/campfire/...`. It must
 *    request assets at `/campfire/assets/...`, hit `/campfire/api/v1/...`, and
 *    the router must treat `/campfire` as its basename. Vite's `base` setting
 *    does the asset rewriting automatically; this module supplies the matching
 *    in-app prefix for the API client and the router.
 *  - The prefix is NORMALIZED at build time (see {@link normalizeBasePrefix})
 *    so operators can write `campfire`, `/campfire/`, `/campfire`, etc. — the
 *    internal value is always a bare-ish `/campfire` (leading slash, no
 *    trailing slash), with `/` for the root case.
 */

/**
 * Coerce an arbitrary PUBLIC_BASE input into the canonical form used everywhere
 * in-app: a string that starts with `/`, does NOT end with `/` (unless it is
 * exactly `/`), and carries no query/host. Empty/whitespace/`/` all normalize
 * to `/` (the root deployment — identical to the pre-#798 behavior).
 *
 * Examples:
 *   undefined / '' / '/'         -> '/'
 *   'campfire'                    -> '/campfire'
 *   '/campfire'                   -> '/campfire'
 *   '/campfire/'                  -> '/campfire'
 *   ' /a/b/ '                     -> '/a/b'
 *   'https://host/campfire/'      -> '/campfire'   (host portion dropped —
 *                                                   PUBLIC_BASE is a path)
 *   '//campfire//'                -> '/campfire'   (treated as a path, not a URL)
 *
 * Pure / side-effect-free — safe to import from vite.config.ts (Node context)
 * as well as the SPA bundle.
 */
export function normalizeBasePrefix(input: string | undefined): string {
  const trimmed = (input ?? '').trim();
  if (trimmed === '') return '/';
  let pathname: string;
  try {
    // Accept a full URL (operator pastes the public origin) by parsing and
    // keeping only the pathname — PUBLIC_BASE is a path, never an origin.
    // Only an explicit http(s):// scheme is parsed as a URL; a protocol-
    // relative `//host/path` is intentionally treated as a PATH (the leading-//
    // is collapsed by the normalize step below) because distinguishing
    // `//host/path` (URL) from `//path` (typo'd path) is unreliable, and an
    // operator who means a URL will write the scheme.
    if (/^https?:\/\//i.test(trimmed)) {
      pathname = new URL(trimmed).pathname;
    } else {
      pathname = trimmed;
    }
  } catch {
    pathname = trimmed;
  }
  // Force a leading slash so the value is origin-relative, not a path-relative
  // segment that would resolve against whatever URL the SPA happens to load on.
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  // Collapse accidental double slashes inside the prefix (e.g. `//a//b/`).
  pathname = pathname.replace(/\/+/g, '/');
  // Strip any trailing slash (except for the bare root).
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return pathname === '' ? '/' : pathname;
}

/**
 * The normalized public base path for THIS build. Stamped in at build time by
 * `vite.config.ts` (which reads `process.env.PUBLIC_BASE` and passes the
 * normalized value through `define`). At runtime this is a bare string
 * constant — no env access, no window sniffing — so it is safe to import from
 * any module, including the service worker.
 */
// Vite injects __PUBLIC_BASE__ as a string literal (JSON.stringify-quoted) at
// build time. `typeof` on an undeclared variable is the one safe way to test
// for it without a ReferenceError (and without `any`).
export const PUBLIC_BASE: string =
  typeof __PUBLIC_BASE__ !== 'undefined' ? __PUBLIC_BASE__ : '/';

/**
 * Whether this build is deployed under a subpath (any non-root prefix). Used to
 * gate behaviors that only matter when the prefix is non-empty (e.g. deciding
 * whether the SW deny list needs to be prefixed).
 */
export const HAS_SUBPATH: boolean = PUBLIC_BASE !== '/';

/**
 * Join the public base prefix to a path. The result is the absolute,
 * origin-relative URL the browser must fetch under a strip-prefix reverse
 * proxy (the proxy strips PUBLIC_BASE before forwarding to the server). The
 * input is expected to start with `/` (e.g. the
 * in-app `/api/v1/...`); a non-slashed input is treated as a router-relative
 * path and joined after a single slash.
 *
 * `joinPublicBase('/api/v1/x')` with PUBLIC_BASE `/campfire` -> `/campfire/api/v1/x`.
 * `joinPublicBase('/api/v1/x')` with PUBLIC_BASE `/`         -> `/api/v1/x`.
 */
export function joinPublicBase(path: string): string {
  if (PUBLIC_BASE === '/') return path;
  if (path.startsWith('/')) return `${PUBLIC_BASE}${path}`;
  return `${PUBLIC_BASE}/${path}`;
}

// Tell TypeScript that vite.config.ts's `define` injection exists at runtime.
// Declared in an ambient block so the SAME source file can be imported from
// Node (vite.config.ts) — there `__PUBLIC_BASE__` is genuinely undefined at
// module-load, and the typeof guard above falls through to '/'.
declare const __PUBLIC_BASE__: string;
