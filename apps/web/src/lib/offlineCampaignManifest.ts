/**
 * Explicit per-campaign offline pack (issue #879).
 *
 * Accidental NetworkFirst caching of every `/api` GET is unsafe (SSE, exports,
 * backups). Offline survival instead uses a named, bounded manifest of campaign
 * JSON reads (+ optional attachment thumbs). Callers download the pack on
 * purpose; inspect reports present / missing / stale so the UI can show
 * indicators instead of silently replaying unbounded Cache Storage entries.
 */

import {
  API_CACHE_MAX_AGE_SECONDS,
  API_IMAGE_CACHE_NAME,
  API_IMAGE_MAX_BYTES,
  API_IMAGE_MAX_ENTRIES,
  API_JSON_CACHE_NAME,
  API_JSON_MAX_BYTES,
  API_JSON_MAX_ENTRIES,
  cacheWillUpdateImage,
  cacheWillUpdateJson,
} from './pwaCachePolicy';

export type OfflineManifestKind = 'json' | 'image';

export interface OfflineManifestEntry {
  /** Absolute path (+ query), e.g. `/api/v1/campaigns/3/summary`. */
  url: string;
  kind: OfflineManifestKind;
  /** When true, a missing entry marks the whole pack incomplete. */
  required: boolean;
}

export type OfflineEntryStatus = 'present' | 'missing' | 'stale';

export interface OfflineEntryInspection {
  url: string;
  kind: OfflineManifestKind;
  required: boolean;
  status: OfflineEntryStatus;
  cachedAt: number | null;
  bytes: number | null;
}

export interface OfflineManifestInspection {
  campaignId: number;
  downloadedAt: number | null;
  entries: OfflineEntryInspection[];
  /** True when every required entry is present and fresh. */
  complete: boolean;
  missingCount: number;
  staleCount: number;
}

interface StoredEntryMeta {
  cachedAt: number;
  bytes: number;
  cacheName: string;
}

interface StoredManifestMeta {
  campaignId: number;
  downloadedAt: number;
  entries: Record<string, StoredEntryMeta>;
}

const META_KEY_PREFIX = 'cf.offlineManifest.';

function metaKey(campaignId: number): string {
  return `${META_KEY_PREFIX}${campaignId}`;
}

/** Bounded read set a table can pin for offline between sessions. */
export function campaignOfflineManifest(campaignId: number): OfflineManifestEntry[] {
  if (!Number.isFinite(campaignId) || campaignId <= 0) {
    throw new RangeError(`campaignId must be a positive number, got ${campaignId}`);
  }
  const base = `/api/v1/campaigns/${campaignId}`;
  return [
    { url: `${base}/summary`, kind: 'json', required: true },
    { url: `${base}/characters`, kind: 'json', required: true },
    { url: `${base}/quests`, kind: 'json', required: true },
    { url: `${base}/npcs`, kind: 'json', required: true },
    { url: `${base}/locations`, kind: 'json', required: true },
    { url: `${base}/sessions`, kind: 'json', required: true },
    { url: `${base}/notes`, kind: 'json', required: true },
    { url: `${base}/encounters`, kind: 'json', required: true },
    { url: `${base}/schedule`, kind: 'json', required: false },
    { url: `${base}/attachments`, kind: 'json', required: false },
  ];
}

export function readOfflineManifestMeta(campaignId: number): StoredManifestMeta | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(metaKey(campaignId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredManifestMeta>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.campaignId !== campaignId) return null;
    if (typeof parsed.downloadedAt !== 'number' || !Number.isFinite(parsed.downloadedAt)) return null;
    if (!parsed.entries || typeof parsed.entries !== 'object') return null;
    return parsed as StoredManifestMeta;
  } catch {
    return null;
  }
}

export function clearOfflineManifestMeta(campaignId: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(metaKey(campaignId));
  } catch {
    /* ignore */
  }
}

/** Drop every campaign's offline-pack bookkeeping (logout / account switch). */
/** Bumped on logout / clear so in-flight pack downloads stop writing. */
let offlinePackGeneration = 0;

/** Cancel in-flight offline pack downloads (call from logout / cache clear). */
export function cancelOfflinePackDownloads(): void {
  offlinePackGeneration += 1;
}

export function clearAllOfflineManifestMeta(): void {
  cancelOfflinePackDownloads();
  if (typeof localStorage === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(META_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** UI seam: one label for present / stale / missing pack state. */
export type OfflinePackIndicator = 'ready' | 'stale' | 'incomplete' | 'missing';

export function offlinePackIndicator(inspection: OfflineManifestInspection): OfflinePackIndicator {
  const required = inspection.entries.filter((e) => e.required);
  const requiredMissing = required.some((e) => e.status === 'missing');
  const requiredStale = required.some((e) => e.status === 'stale');
  const allMissing = inspection.entries.length > 0 && inspection.entries.every((e) => e.status === 'missing');

  if (allMissing && inspection.downloadedAt == null) return 'missing';
  // True gaps on required entries beat staleness for the banner.
  if (requiredMissing) return 'incomplete';
  // Stale required (or optional) entries surface as stale — not incomplete.
  if (requiredStale || inspection.staleCount > 0) return 'stale';
  if (required.every((e) => e.status === 'present')) return 'ready';
  if (allMissing) return 'missing';
  return 'incomplete';
}

function writeOfflineManifestMeta(meta: StoredManifestMeta): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(metaKey(meta.campaignId), JSON.stringify(meta));
  } catch {
    /* quota / private mode — inspect will treat as missing meta */
  }
}

function isStale(cachedAt: number, now: number): boolean {
  return now - cachedAt > API_CACHE_MAX_AGE_SECONDS * 1000;
}

export async function inspectCampaignOfflineManifest(
  campaignId: number,
  opts: { now?: number; caches?: CacheStorage } = {},
): Promise<OfflineManifestInspection> {
  const now = opts.now ?? Date.now();
  const cacheStorage =
    opts.caches ?? (typeof globalThis.caches !== 'undefined' ? globalThis.caches : undefined);
  const manifest = campaignOfflineManifest(campaignId);
  const meta = readOfflineManifestMeta(campaignId);

  let jsonCache: Cache | null = null;
  let imageCache: Cache | null = null;
  if (cacheStorage) {
    try {
      jsonCache = await cacheStorage.open(API_JSON_CACHE_NAME);
    } catch {
      jsonCache = null;
    }
    try {
      imageCache = await cacheStorage.open(API_IMAGE_CACHE_NAME);
    } catch {
      imageCache = null;
    }
  }

  const entries: OfflineEntryInspection[] = [];
  for (const entry of manifest) {
    const stored = meta?.entries[entry.url] ?? null;
    let inCache = false;
    const cache = entry.kind === 'image' ? imageCache : jsonCache;
    if (cache) {
      try {
        const hit = await cache.match(entry.url);
        inCache = !!hit;
      } catch {
        inCache = false;
      }
    }

    let status: OfflineEntryStatus = 'missing';
    if (inCache && stored) {
      status = isStale(stored.cachedAt, now) ? 'stale' : 'present';
    } else if (inCache && !stored) {
      // Workbox may populate the JSON bucket during normal online use without
      // offline-pack metadata. Only treat that as stale when a pack was once
      // downloaded (meta exists) and we lost per-entry bookkeeping.
      status = meta ? 'stale' : 'missing';
    } else {
      status = 'missing';
    }

    entries.push({
      url: entry.url,
      kind: entry.kind,
      required: entry.required,
      status,
      cachedAt: stored?.cachedAt ?? null,
      bytes: stored?.bytes ?? null,
    });
  }

  const missingCount = entries.filter((e) => e.status === 'missing').length;
  const staleCount = entries.filter((e) => e.status === 'stale').length;
  const requiredOk = entries.every((e) => !e.required || e.status === 'present');

  return {
    campaignId,
    downloadedAt: meta?.downloadedAt ?? null,
    entries,
    complete: requiredOk,
    missingCount,
    staleCount,
  };
}

export interface OfflineDownloadProgress {
  completed: number;
  total: number;
  url: string;
  ok: boolean;
  reason?: string;
}

export interface OfflineDownloadResult {
  ok: boolean;
  downloadedAt: number;
  stored: number;
  failed: Array<{ url: string; reason: string }>;
  quotaExceeded: boolean;
  evicted: number;
}

async function measureBytes(response: Response): Promise<number> {
  // Always measure the body — Content-Length can understate the payload.
  const buf = await response.clone().arrayBuffer();
  return buf.byteLength;
}

function cacheEntryPath(url: string): string {
  try {
    const u = new URL(url, 'http://local');
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function dropMetaEntry(metaEntries: Record<string, StoredEntryMeta> | undefined, path: string): void {
  if (!metaEntries) return;
  const normalized = cacheEntryPath(path);
  // Exact key match only (path-only or absolute URL forms), never suffix collisions.
  if (path in metaEntries) delete metaEntries[path];
  if (normalized in metaEntries) delete metaEntries[normalized];
  for (const key of Object.keys(metaEntries)) {
    if (cacheEntryPath(key) === normalized) delete metaEntries[key];
  }
}

/**
 * Evict oldest entries from a cache until under maxEntries.
 * Optionally deletes `evictFirstUrls` before applying the overflow trim.
 * When `metaEntries` is provided, matching bookkeeping records are pruned too.
 */
export async function evictCacheEntries(
  cache: Cache,
  opts: {
    maxEntries: number;
    metaEntries?: Record<string, StoredEntryMeta>;
    /** URLs to delete first when making room for a new write (not "prefer to keep"). */
    evictFirstUrls?: string[];
  },
): Promise<number> {
  const keys = await cache.keys();
  if (keys.length <= opts.maxEntries && !opts.evictFirstUrls?.length) return 0;

  // Oldest cachedAt first; unknown meta sorts as oldest.
  const ranked = keys.map((req) => {
    const url = typeof req === 'string' ? req : req.url;
    const path = cacheEntryPath(url);
    const cachedAt = opts.metaEntries?.[path]?.cachedAt ?? 0;
    return { req, path, cachedAt };
  });
  ranked.sort((a, b) => a.cachedAt - b.cachedAt);

  let deleted = 0;
  // Drop caller-requested URLs first (make room for a new write).
  for (const target of opts.evictFirstUrls ?? []) {
    const hit = ranked.find((r) => r.path === target || r.req.url.endsWith(target));
    if (!hit) continue;
    await cache.delete(hit.req);
    dropMetaEntry(opts.metaEntries, hit.path);
    deleted += 1;
  }

  const remaining = await cache.keys();
  if (remaining.length <= opts.maxEntries) return deleted;

  const overflow = remaining.length - opts.maxEntries;
  const freshKeys = await cache.keys();
  const reRanked = freshKeys.map((req) => {
    const path = cacheEntryPath(req.url);
    return { req, path, cachedAt: opts.metaEntries?.[path]?.cachedAt ?? 0 };
  });
  reRanked.sort((a, b) => a.cachedAt - b.cachedAt);
  for (let i = 0; i < overflow && i < reRanked.length; i += 1) {
    const hit = reRanked[i]!;
    await cache.delete(hit.req);
    dropMetaEntry(opts.metaEntries, hit.path);
    deleted += 1;
  }
  return deleted;
}

async function putWithQuotaRetry(
  cacheName: string,
  requestUrl: string,
  response: Response,
  maxEntries: number,
  metaEntries: Record<string, StoredEntryMeta>,
  now: number = Date.now(),
): Promise<{ ok: boolean; quotaExceeded: boolean; evicted: number; reason?: string }> {
  if (typeof globalThis.caches === 'undefined') {
    return { ok: false, quotaExceeded: false, evicted: 0, reason: 'no-cache-storage' };
  }
  const cache = await globalThis.caches.open(cacheName);
  let evicted = 0;
  try {
    await cache.put(requestUrl, response.clone());
    // Rank the fresh write as newest before LRU eviction so a full bucket
    // cannot immediately drop the entry we just stored (cachedAt default 0).
    metaEntries[requestUrl] = {
      cachedAt: now,
      bytes: metaEntries[requestUrl]?.bytes ?? 0,
      cacheName,
    };
    evicted += await evictCacheEntries(cache, { maxEntries, metaEntries });
    return { ok: true, quotaExceeded: false, evicted };
  } catch (err) {
    const quota =
      (err instanceof DOMException && err.name === 'QuotaExceededError') ||
      (err instanceof Error && /quota/i.test(err.message));
    if (!quota) {
      return {
        ok: false,
        quotaExceeded: false,
        evicted,
        reason: err instanceof Error ? err.message : 'cache-put-failed',
      };
    }
    // Make room via the same LRU/meta-aware path, then retry once.
    const keys = await cache.keys();
    const half = Math.max(0, Math.floor(keys.length / 2));
    evicted += await evictCacheEntries(cache, {
      maxEntries: half,
      metaEntries,
      evictFirstUrls: [requestUrl],
    });
    try {
      await cache.put(requestUrl, response.clone());
      metaEntries[requestUrl] = {
        cachedAt: now,
        bytes: metaEntries[requestUrl]?.bytes ?? 0,
        cacheName,
      };
      evicted += await evictCacheEntries(cache, { maxEntries, metaEntries });
      return { ok: true, quotaExceeded: true, evicted };
    } catch {
      return {
        ok: false,
        quotaExceeded: true,
        evicted,
        reason: 'quota-exceeded',
      };
    }
  }
}

/**
 * Fetch each manifest URL and write successful, policy-allowed responses into
 * the bounded JSON/image caches. Streams/exports never appear in the manifest.
 */
export async function downloadCampaignOfflinePack(
  campaignId: number,
  opts: {
    fetchImpl?: typeof fetch;
    now?: number;
    onProgress?: (p: OfflineDownloadProgress) => void;
    /** Optional thumb URLs (`/api/v1/attachments/:id?size=thumb`) to pin. */
    extraImageUrls?: string[];
  } = {},
): Promise<OfflineDownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const generation = offlinePackGeneration;
  const manifest = campaignOfflineManifest(campaignId);
  const extras: OfflineManifestEntry[] = (opts.extraImageUrls ?? []).map((url) => ({
    url,
    kind: 'image' as const,
    required: false,
  }));
  const all = [...manifest, ...extras];

  const entryMeta: Record<string, StoredEntryMeta> = {
    ...(readOfflineManifestMeta(campaignId)?.entries ?? {}),
  };
  const failed: Array<{ url: string; reason: string }> = [];
  let stored = 0;
  let evicted = 0;
  let quotaExceeded = false;

  let completed = 0;
  for (const entry of all) {
    if (generation !== offlinePackGeneration) {
      return {
        ok: false,
        downloadedAt: now,
        stored,
        failed: [...failed, { url: entry.url, reason: 'cancelled' }],
        quotaExceeded,
        evicted,
      };
    }
    try {
      const headers: Record<string, string> = {
        accept: entry.kind === 'image' ? 'image/*' : 'application/json',
      };
      // Mirror api.ts so DEV_AUTH tables can download packs without 401/403.
      try {
        const devRole = typeof localStorage !== 'undefined' ? localStorage.getItem('cf.devRole') : null;
        const devUser = typeof localStorage !== 'undefined' ? localStorage.getItem('cf.devUser') : null;
        if (devRole) headers['x-dev-role'] = devRole;
        if (devUser) headers['x-dev-user'] = devUser;
      } catch {
        /* private mode / unavailable storage */
      }
      const res = await fetchImpl(entry.url, {
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        failed.push({ url: entry.url, reason: `http-${res.status}` });
        opts.onProgress?.({ completed: ++completed, total: all.length, url: entry.url, ok: false, reason: `http-${res.status}` });
        continue;
      }

      const gate = entry.kind === 'image' ? cacheWillUpdateImage : cacheWillUpdateJson;
      const allowed = await gate({ response: res });
      if (!allowed) {
        failed.push({ url: entry.url, reason: 'policy-reject' });
        opts.onProgress?.({ completed: ++completed, total: all.length, url: entry.url, ok: false, reason: 'policy-reject' });
        continue;
      }

      const bytes = await measureBytes(allowed);
      const maxBytes = entry.kind === 'image' ? API_IMAGE_MAX_BYTES : API_JSON_MAX_BYTES;
      if (bytes > maxBytes) {
        failed.push({ url: entry.url, reason: 'oversized' });
        opts.onProgress?.({ completed: ++completed, total: all.length, url: entry.url, ok: false, reason: 'oversized' });
        continue;
      }

      const cacheName = entry.kind === 'image' ? API_IMAGE_CACHE_NAME : API_JSON_CACHE_NAME;
      const maxEntries = entry.kind === 'image' ? API_IMAGE_MAX_ENTRIES : API_JSON_MAX_ENTRIES;
      const put = await putWithQuotaRetry(cacheName, entry.url, allowed, maxEntries, entryMeta, now);
      evicted += put.evicted;
      if (put.quotaExceeded) quotaExceeded = true;
      if (!put.ok) {
        failed.push({ url: entry.url, reason: put.reason ?? 'cache-put-failed' });
        opts.onProgress?.({ completed: ++completed, total: all.length, url: entry.url, ok: false, reason: put.reason });
        continue;
      }

      entryMeta[entry.url] = { cachedAt: now, bytes, cacheName };
      stored += 1;
      opts.onProgress?.({ completed: ++completed, total: all.length, url: entry.url, ok: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'fetch-failed';
      failed.push({ url: entry.url, reason });
      opts.onProgress?.({ completed: ++completed, total: all.length, url: entry.url, ok: false, reason });
    }
  }

  const downloadedAt = now;
  // Skip writing an empty shell after a total failure (keeps banner at "missing").
  // Also skip if logout/clear bumped the generation mid-download.
  if (generation === offlinePackGeneration && (stored > 0 || Object.keys(entryMeta).length > 0)) {
    // If nothing new was stored and we only carried prior meta, still refresh only when stored>0
    // or we had successful puts this run.
    if (stored > 0) {
      writeOfflineManifestMeta({ campaignId, downloadedAt, entries: entryMeta });
    }
  }

  return {
    ok: failed.length === 0 && generation === offlinePackGeneration,
    downloadedAt,
    stored,
    failed,
    quotaExceeded,
    evicted,
  };
}
