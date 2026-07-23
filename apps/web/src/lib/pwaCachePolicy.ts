/**
 * PWA runtime-cache policy (issue #879).
 *
 * Workbox previously NetworkFirst-cached every successful `/api` GET into one
 * 100-entry bucket. That silently pulled in never-ending campaign/AI SSE streams
 * plus large export/backup/attachment downloads — Workbox clones responses for
 * cache writes, which risks lifetime stream work, quota exhaustion, stale
 * replay, and eviction of useful offline JSON.
 *
 * These helpers are the single source of truth for:
 *   - which API GETs must be NetworkOnly (never cached)
 *   - which GETs may enter the bounded JSON vs image runtime caches
 *   - which responses are rejected at cache-write time (SSE, downloads, oversized)
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
 * Legacy pre-#879 bucket. Still purged on identity change so leftover sensitive
 * entries from older workers cannot survive an upgrade/logout.
 */
export const LEGACY_API_CACHE_NAME = 'campfire-api';

/** Runtime caches the client may wipe on auth / restore. */
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
 * True when this GET must bypass runtime caching entirely (NetworkOnly).
 * Covers SSE streams, identity, backups/exports, admin/credentials, and
 * unbounded attachment downloads (non-thumb).
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
  if (path.includes('/export')) return true;

  // Admin / credential surfaces — never retain in Cache Storage.
  if (path.startsWith('/api/v1/admin/')) return true;
  if (path.startsWith('/api/v1/tokens')) return true;

  // Attachment bytes are unbounded (up to 32 MiB). Only `?size=thumb` may use
  // the image cache; originals stay NetworkOnly.
  if (path.startsWith('/api/v1/attachments/')) {
    return url.searchParams.get('size') !== 'thumb';
  }

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
 * Remaining safe API GETs (JSON campaign reads, etc.). NetworkOnly / image
 * matchers are registered first so this never sees streams or downloads.
 *
 * SELF-CONTAINED for workbox `.toString()` embedding — duplicates the NetworkOnly
 * / image predicates instead of calling them (those names are absent in sw.js).
 */
export function matchApiJsonCache({ url, request }: WorkboxMatchOptions): boolean {
  if (request.method !== 'GET') return false;
  if (!url.pathname.startsWith('/api/')) return false;

  const path = url.pathname;
  const accept = request.headers.get('accept') || '';

  if (path === '/api/v1/me' || path.startsWith('/api/v1/auth/')) return false;
  if (accept.includes('text/event-stream')) return false;
  if (/\/campaigns\/[^/]+\/events$/.test(path) || path.endsWith('/ai-dm/stream')) return false;
  if (path === '/api/v1/backup' || path.startsWith('/api/v1/backup/')) return false;
  if (path.includes('/export')) return false;
  if (path.startsWith('/api/v1/admin/')) return false;
  if (path.startsWith('/api/v1/tokens')) return false;
  if (path.startsWith('/api/v1/attachments/')) return false;

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
 * downloads, non-JSON bodies, and oversized payloads (Content-Length or measured).
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

  const cd = response.headers.get('content-disposition') || '';
  if (/attachment/i.test(cd)) return null;

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return null;
  if (!ct.includes('application/json') && !ct.includes('+json')) return null;

  const rawLen = response.headers.get('content-length');
  if (rawLen != null && rawLen !== '') {
    const n = Number(rawLen);
    if (Number.isFinite(n) && n > 512 * 1024) return null;
  } else {
    // No Content-Length (chunked / some proxies): measure a clone so we never
    // pin an unbounded body into Cache Storage.
    try {
      const buf = await response.clone().arrayBuffer();
      if (buf.byteLength > 512 * 1024) return null;
    } catch {
      return null;
    }
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

  const cd = response.headers.get('content-disposition') || '';
  if (/attachment/i.test(cd)) return null;

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return null;
  if (!ct.startsWith('image/')) return null;

  const rawLen = response.headers.get('content-length');
  if (rawLen != null && rawLen !== '') {
    const n = Number(rawLen);
    if (Number.isFinite(n) && n > 256 * 1024) return null;
  } else {
    try {
      const buf = await response.clone().arrayBuffer();
      if (buf.byteLength > 256 * 1024) return null;
    } catch {
      return null;
    }
  }

  return response;
}

/** Classify a Response for tests / offline-pack bookkeeping. */
export function classifyApiResponseForCache(
  response: Response,
): 'json' | 'image' | 'reject' {
  if (isEventStream(response) || isAttachmentDownload(response)) return 'reject';
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
