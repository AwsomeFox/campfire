/**
 * PWA runtime-cache policy (issues #879 + #730).
 *
 * #879 split Workbox API caching into NetworkOnly (SSE / exports / backups /
 * unbounded downloads) plus bounded JSON and image-thumb buckets, with
 * cacheWillUpdate gates and an explicit offline pack.
 *
 * #730 extends that policy for privacy/disaster-recovery:
 *   - JSON caching is an allowlist of bounded campaign/entity/rule reads
 *     (not “every remaining GET”)
 *   - capability-token, credential, invite, and settings surfaces stay NetworkOnly
 *   - Cache-Control: no-store responses are never written
 *   - legacy / sensitive Cache Storage entries are purged on worker activation
 *     (see public/sw-sensitive-purge.js) and on logout via {@link MANAGED_API_CACHE_NAMES}
 *
 * Matcher functions below are intentionally self-contained (no closure over
 * imported bindings) so vite-plugin-pwa / workbox-build can embed them into the
 * generated service worker via `Function.prototype.toString()`.
 */

/** Bounded JSON API GETs (campaign reads, etc.). */
export const API_JSON_CACHE_NAME = 'campfire-api-json';

/** Bounded image thumbs only (`/attachments/:id?size=thumb`). */
export const API_IMAGE_CACHE_NAME = 'campfire-api-images';

/**
 * Legacy pre-#879 bucket. Still purged on identity change / activate so leftover
 * sensitive entries from older workers cannot survive an upgrade/logout.
 */
export const LEGACY_API_CACHE_NAME = 'campfire-api';

/** Runtime caches the client may wipe on auth / restore / activate. */
export const MANAGED_API_CACHE_NAMES = [
  API_JSON_CACHE_NAME,
  API_IMAGE_CACHE_NAME,
  LEGACY_API_CACHE_NAME,
] as const;

export const API_JSON_MAX_ENTRIES = 80;
export const API_IMAGE_MAX_ENTRIES = 40;
export const API_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Soft body caps — oversized responses are never written to Cache Storage. */
export const API_JSON_MAX_BYTES = 512 * 1024; // 512 KiB
export const API_IMAGE_MAX_BYTES = 256 * 1024; // 256 KiB (thumbs)

export type WorkboxMatchOptions = {
  url: URL;
  request: Request;
};

/**
 * Pathname heuristics for sensitive API surfaces (issue #730). Used by tests,
 * activation purge, and kept in sync with the inlined checks inside the
 * Workbox matchers (those must stay self-contained for `.toString()` embedding).
 *
 * Covers backups/exports, auth/credentials, admin/settings, capability-token
 * URLs (shared recaps, ICS, invites), and unbounded attachment originals.
 */
export function isSensitiveApiPathname(path: string): boolean {
  if (path === '/api/v1/me' || path.startsWith('/api/v1/auth/')) return true;
  if (path === '/api/v1/backup' || path.startsWith('/api/v1/backup/')) return true;
  if (/\/export(\/|$)/.test(path)) return true;
  if (path.startsWith('/api/v1/admin/')) return true;
  if (path.startsWith('/api/v1/settings/')) return true;
  if (path.startsWith('/api/v1/oauth/')) return true;
  if (path.startsWith('/api/v1/tokens') || /\/tokens(\/|$)/.test(path)) return true;
  if (path.startsWith('/api/v1/users/')) return true;
  if (path.startsWith('/api/v1/notifications')) return true;
  if (path.startsWith('/api/v1/shared/')) return true;
  if (path.startsWith('/api/v1/calendar/')) return true;
  if (/\/calendar-feed(\/|$)/.test(path)) return true;
  if (path.startsWith('/api/v1/invites') || /\/invites(\/|$)/.test(path)) return true;
  if (/\/ai-provider(\/|$)/.test(path)) return true;
  if (path.startsWith('/api/v1/mcp')) return true;
  if (/^\/api\/v1\/encounters\/\d+\/map$/.test(path)) return true;
  // Attachment *originals* are sensitive; thumbs are handled via URL search in
  // {@link isSensitiveCachedRequest} so activate purge does not wipe the image bucket.
  return false;
}

/** Sensitive cache keys including non-thumb attachment URLs (issue #730). */
export function isSensitiveCachedRequest(url: URL): boolean {
  if (isSensitiveApiPathname(url.pathname)) return true;
  if (url.pathname.startsWith('/api/v1/attachments/')) {
    return url.searchParams.get('size') !== 'thumb';
  }
  return false;
}

/**
 * #730 allowlist: bounded non-sensitive JSON reads that may enter the JSON
 * runtime cache (after NetworkOnly exclusions). Everything else stays uncached.
 */
export function isAllowlistedJsonApiPath(path: string): boolean {
  if (path === '/api/v1/campaigns' || path === '/api/v1/campaigns/trash') return true;
  if (/^\/api\/v1\/campaigns\/\d+(\/|$)/.test(path)) return true;
  if (
    /^\/api\/v1\/(sessions|characters|quests|npcs|locations|notes|encounters|factions|arcs|beats|timeline|comments|rolls|proposals|inventory|schedule|revisions)\/\d+(\/|$)/.test(
      path,
    )
  ) {
    return true;
  }
  if (path.startsWith('/api/v1/rules/')) return true;
  return false;
}

/** True when Cache-Control forbids storing the response (issue #730). */
export function responseHasNoStore(response: Response): boolean {
  const cc = response.headers.get('cache-control') || '';
  return /\bno-store\b/i.test(cc);
}

/**
 * True when this GET must bypass runtime caching entirely (NetworkOnly).
 * Covers SSE streams, identity, backups/exports, admin/credentials, capability
 * URLs, and unbounded attachment downloads (non-thumb).
 *
 * SELF-CONTAINED: workbox-build embeds this via `.toString()` into sw.js, so it
 * must not close over or call other module bindings.
 */
export function matchNetworkOnlyApi({ url, request }: WorkboxMatchOptions): boolean {
  if (request.method !== 'GET') return false;
  if (!url.pathname.startsWith('/api/')) return false;

  const path = url.pathname;
  const accept = request.headers.get('accept') || '';

  // Identity channel — proven-live only (issue #579); never SW-cached.
  if (path === '/api/v1/me' || path.startsWith('/api/v1/auth/')) return true;

  // SSE: Accept header and/or known stream paths (campaign SSE + AI-DM).
  // Do NOT treat every `/events` suffix as a stream — encounter combat-log
  // JSON lives at `/api/v1/encounters/:id/events` and should stay cacheable.
  if (accept.includes('text/event-stream')) return true;
  if (/\/campaigns\/[^/]+\/events$/.test(path) || path.endsWith('/ai-dm/stream')) return true;

  // Whole-server backup + campaign/member exports (issues #730 / #879).
  if (path === '/api/v1/backup' || path.startsWith('/api/v1/backup/')) return true;
  // Path-segment match so `/exporter` does not catch `/exporterer`.
  if (/\/export(\/|$)/.test(path)) return true;

  // Admin / settings / oauth / credential surfaces — never retain in Cache Storage.
  if (path.startsWith('/api/v1/admin/')) return true;
  if (path.startsWith('/api/v1/settings/')) return true;
  if (path.startsWith('/api/v1/oauth/')) return true;
  if (path.startsWith('/api/v1/tokens') || /\/tokens(\/|$)/.test(path)) return true;
  if (path.startsWith('/api/v1/users/')) return true;
  if (path.startsWith('/api/v1/notifications')) return true;
  if (path.startsWith('/api/v1/mcp')) return true;

  // Capability-token URLs (shared recaps, ICS feeds, invites) — #730.
  if (path.startsWith('/api/v1/shared/')) return true;
  if (path.startsWith('/api/v1/calendar/')) return true;
  if (/\/calendar-feed(\/|$)/.test(path)) return true;
  if (path.startsWith('/api/v1/invites') || /\/invites(\/|$)/.test(path)) return true;

  // AI provider credential metadata (redacted, but still credential-adjacent).
  if (/\/ai-provider(\/|$)/.test(path)) return true;

  // Attachment bytes are unbounded (up to 32 MiB). Only `?size=thumb` may use
  // the image cache; originals stay NetworkOnly.
  if (path.startsWith('/api/v1/attachments/')) {
    return url.searchParams.get('size') !== 'thumb';
  }

  // Role/fog-specific VTT map renders — never Cache Storage (#463).
  if (/^\/api\/v1\/encounters\/\d+\/map$/.test(path)) return true;

  return false;
}

/**
 * Bounded attachment thumbnails — separate quota from JSON so a burst of thumbs
 * cannot evict campaign summary/list responses.
 *
 * SELF-CONTAINED for workbox `.toString()` embedding (see matchNetworkOnlyApi).
 */
export function matchApiImageCache({ url, request }: WorkboxMatchOptions): boolean {
  if (request.method !== 'GET') return false;
  if (!url.pathname.startsWith('/api/v1/attachments/')) return false;
  return url.searchParams.get('size') === 'thumb';
}

/**
 * Allowlisted safe API GETs (JSON campaign/entity/rule reads). NetworkOnly /
 * image matchers are registered first so this never sees streams or downloads.
 *
 * SELF-CONTAINED for workbox `.toString()` embedding — duplicates the NetworkOnly
 * / allowlist predicates instead of calling them (those names are absent in sw.js).
 */
export function matchApiJsonCache({ url, request }: WorkboxMatchOptions): boolean {
  if (request.method !== 'GET') return false;
  if (!url.pathname.startsWith('/api/')) return false;

  const path = url.pathname;
  const accept = request.headers.get('accept') || '';

  // Issue #730: allowlist bounded non-sensitive JSON — not every remaining GET.
  const allowlisted =
    path === '/api/v1/campaigns' ||
    path === '/api/v1/campaigns/trash' ||
    /^\/api\/v1\/campaigns\/\d+(\/|$)/.test(path) ||
    /^\/api\/v1\/(sessions|characters|quests|npcs|locations|notes|encounters|factions|arcs|beats|timeline|comments|rolls|proposals|inventory|schedule|revisions)\/\d+(\/|$)/.test(
      path,
    ) ||
    path.startsWith('/api/v1/rules/');
  if (!allowlisted) return false;

  if (path === '/api/v1/me' || path.startsWith('/api/v1/auth/')) return false;
  if (accept.includes('text/event-stream')) return false;
  if (/\/campaigns\/[^/]+\/events$/.test(path) || path.endsWith('/ai-dm/stream')) return false;
  if (path === '/api/v1/backup' || path.startsWith('/api/v1/backup/')) return false;
  if (/\/export(\/|$)/.test(path)) return false;
  if (path.startsWith('/api/v1/admin/')) return false;
  if (path.startsWith('/api/v1/settings/')) return false;
  if (path.startsWith('/api/v1/oauth/')) return false;
  if (path.startsWith('/api/v1/tokens') || /\/tokens(\/|$)/.test(path)) return false;
  if (path.startsWith('/api/v1/users/')) return false;
  if (path.startsWith('/api/v1/notifications')) return false;
  if (path.startsWith('/api/v1/mcp')) return false;
  if (path.startsWith('/api/v1/shared/')) return false;
  if (path.startsWith('/api/v1/calendar/')) return false;
  if (/\/calendar-feed(\/|$)/.test(path)) return false;
  if (path.startsWith('/api/v1/invites') || /\/invites(\/|$)/.test(path)) return false;
  if (/\/ai-provider(\/|$)/.test(path)) return false;
  if (path.startsWith('/api/v1/attachments/')) return false;
  if (/^\/api\/v1\/encounters\/\d+\/map$/.test(path)) return false;

  return true;
}

function contentLengthBytes(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isAttachmentDownload(response: Response): boolean {
  const cd = response.headers.get('content-disposition') || '';
  return /attachment/i.test(cd);
}

function isEventStream(response: Response): boolean {
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/event-stream');
}

/**
 * cacheWillUpdate gate for the JSON bucket. Rejects SSE, Content-Disposition
 * downloads, Cache-Control: no-store, non-JSON bodies, and oversized payloads.
 *
 * SELF-CONTAINED for workbox `.toString()` embedding into sw.js.
 */
export async function cacheWillUpdateJson({
  response,
}: {
  response?: Response | null;
}): Promise<Response | null> {
  if (!response) return null;
  if (response.status !== 200 && response.status !== 0) return null;

  const cc = response.headers.get('cache-control') || '';
  if (/\bno-store\b/i.test(cc)) return null;

  const cd = response.headers.get('content-disposition') || '';
  if (/attachment/i.test(cd)) return null;

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return null;
  if (!ct.includes('application/json') && !ct.includes('+json')) return null;

  // Honor Content-Length when present (tests + honest servers), then still
  // measure the body — Content-Length can also understate the payload.
  const jsonMaxBytes = 512 * 1024;
  const declared = response.headers.get('content-length');
  if (declared != null && declared !== '') {
    const n = Number(declared);
    if (Number.isFinite(n) && n > jsonMaxBytes) return null;
  }
  try {
    const body = response.clone().body;
    if (!body) return null;
    const reader = body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > jsonMaxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
    }
  } catch {
    return null;
  }

  return response;
}

/**
 * cacheWillUpdate gate for the image-thumb bucket.
 *
 * SELF-CONTAINED for workbox `.toString()` embedding into sw.js.
 */
export async function cacheWillUpdateImage({
  response,
}: {
  response?: Response | null;
}): Promise<Response | null> {
  if (!response) return null;
  if (response.status !== 200 && response.status !== 0) return null;

  const cc = response.headers.get('cache-control') || '';
  if (/\bno-store\b/i.test(cc)) return null;

  const cd = response.headers.get('content-disposition') || '';
  if (/attachment/i.test(cd)) return null;

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return null;
  if (!ct.startsWith('image/')) return null;

  // Honor Content-Length when present, then still measure the body.
  const imageMaxBytes = 256 * 1024;
  const declared = response.headers.get('content-length');
  if (declared != null && declared !== '') {
    const n = Number(declared);
    if (Number.isFinite(n) && n > imageMaxBytes) return null;
  }
  try {
    const body = response.clone().body;
    if (!body) return null;
    const reader = body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > imageMaxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
    }
  } catch {
    return null;
  }

  return response;
}

/** Classify a Response for tests / offline-pack bookkeeping. */
export function classifyApiResponseForCache(
  response: Response,
): 'json' | 'image' | 'reject' {
  if (isEventStream(response) || isAttachmentDownload(response) || responseHasNoStore(response)) {
    return 'reject';
  }
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json') || ct.includes('+json')) {
    const n = contentLengthBytes(response);
    if (n != null && n > API_JSON_MAX_BYTES) return 'reject';
    return 'json';
  }
  if (ct.startsWith('image/')) {
    const n = contentLengthBytes(response);
    if (n != null && n > API_IMAGE_MAX_BYTES) return 'reject';
    return 'image';
  }
  return 'reject';
}

/**
 * Delete legacy API caches and scrub any sensitive URLs that may have been
 * written by an older worker (issue #730 activate + logout hygiene).
 *
 * Safe when Cache Storage is unavailable. Returns the number of cache entries
 * (or whole caches) removed.
 */
export async function purgeSensitiveApiCacheEntries(
  cachesImpl: CacheStorage | undefined = typeof globalThis.caches !== 'undefined'
    ? globalThis.caches
    : undefined,
): Promise<number> {
  if (!cachesImpl) return 0;
  let removed = 0;

  // Drop the pre-#879 monolithic bucket entirely — it may hold exports/backups.
  try {
    if (await cachesImpl.delete(LEGACY_API_CACHE_NAME)) removed += 1;
  } catch {
    /* best-effort */
  }

  for (const name of [API_JSON_CACHE_NAME, API_IMAGE_CACHE_NAME] as const) {
    let cache: Cache;
    try {
      // open() creates the cache if missing; only scrub when it already exists.
      if (!(await cachesImpl.has(name))) continue;
      cache = await cachesImpl.open(name);
    } catch {
      continue;
    }
    let keys: readonly Request[];
    try {
      keys = await cache.keys();
    } catch {
      continue;
    }
    for (const request of keys) {
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        continue;
      }
      if (!isSensitiveCachedRequest(parsed)) continue;
      try {
        if (await cache.delete(request)) removed += 1;
      } catch {
        /* best-effort */
      }
    }
  }

  return removed;
}
