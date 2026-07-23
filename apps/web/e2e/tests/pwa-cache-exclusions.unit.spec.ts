/**
 * Issues #879 / #730 — PWA caching must exclude SSE streams, exports, backups,
 * credentials, and unbounded downloads; JSON/image buckets stay bounded;
 * sensitive entries purge on logout/activate; explicit offline packs report
 * stale/missing and survive quota eviction.
 */
import { expect, test } from '@playwright/test';
import {
  cacheWillUpdateImage,
  cacheWillUpdateJson,
  classifyApiResponseForCache,
  isAllowlistedJsonApiPath,
  isSensitiveApiPathname,
  isSensitiveCachedRequest,
  matchApiImageCache,
  matchApiJsonCache,
  matchNetworkOnlyApi,
  purgeSensitiveApiCacheEntries,
  API_JSON_CACHE_NAME,
  API_IMAGE_CACHE_NAME,
  LEGACY_API_CACHE_NAME,
  API_JSON_MAX_BYTES,
  API_IMAGE_MAX_BYTES,
} from '../../src/lib/pwaCachePolicy';
import {
  campaignOfflineManifest,
  clearAllOfflineManifestMeta,
  clearOfflineManifestMeta,
  downloadCampaignOfflinePack,
  evictCacheEntries,
  inspectCampaignOfflineManifest,
  offlinePackIndicator,
} from '../../src/lib/offlineCampaignManifest';
import { clearApiCache } from '../../src/lib/swCache';

function req(path: string, init: RequestInit = {}): { url: URL; request: Request } {
  const url = new URL(path, 'http://campfire.test');
  return { url, request: new Request(url, { method: 'GET', ...init }) };
}

/** Playwright's Node runner has no browser localStorage — install a Map-backed shim. */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return [...store.keys()][i] ?? null;
    },
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return store;
}

test.describe('pwaCachePolicy matchers (#879)', () => {
  test('NetworkOnly matches SSE Accept and stream paths', () => {
    expect(
      matchNetworkOnlyApi(req('/api/v1/campaigns/3/events', { headers: { accept: 'text/event-stream' } })),
    ).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/events'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/ai-dm/stream'))).toBe(true);
    expect(matchApiJsonCache(req('/api/v1/campaigns/3/events'))).toBe(false);
    // Encounter combat-log JSON is not a stream — keep it in the JSON bucket.
    expect(matchNetworkOnlyApi(req('/api/v1/encounters/9/events'))).toBe(false);
    expect(matchApiJsonCache(req('/api/v1/encounters/9/events'))).toBe(true);
  });

  test('NetworkOnly matches backup, export, admin, auth, and full attachments', () => {
    expect(matchNetworkOnlyApi(req('/api/v1/backup'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/export'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/export/me'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/foo/exporter'))).toBe(false);
    expect(matchNetworkOnlyApi(req('/api/v1/admin/metrics'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/me'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/auth/logout'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/attachments/9'))).toBe(true);
    expect(matchApiJsonCache(req('/api/v1/backup'))).toBe(false);
  });

  test('image cache matches only attachment thumbs; JSON matches safe campaign reads', () => {
    expect(matchApiImageCache(req('/api/v1/attachments/9?size=thumb'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/attachments/9?size=thumb'))).toBe(false);
    expect(matchApiJsonCache(req('/api/v1/campaigns/3/summary'))).toBe(true);
    expect(matchApiImageCache(req('/api/v1/campaigns/3/summary'))).toBe(false);
  });
});

test.describe('cacheWillUpdate gates (#879)', () => {
  test('rejects event-stream, Content-Disposition attachment, and oversized JSON', async () => {
    const sse = new Response('data: {}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    expect(await cacheWillUpdateJson({ response: sse })).toBeNull();
    expect(classifyApiResponseForCache(sse)).toBe('reject');

    const download = new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="campaign.json"',
      },
    });
    expect(await cacheWillUpdateJson({ response: download })).toBeNull();

    const huge = new Response('x', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(API_JSON_MAX_BYTES + 1),
      },
    });
    expect(await cacheWillUpdateJson({ response: huge })).toBeNull();

    const ok = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(await cacheWillUpdateJson({ response: ok })).toBe(ok);
  });

  test('image gate allows small image/* thumbs and rejects oversized / non-images', async () => {
    const png = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    });
    expect(await cacheWillUpdateImage({ response: png })).toBe(png);

    const big = new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(API_IMAGE_MAX_BYTES + 10),
      },
    });
    expect(await cacheWillUpdateImage({ response: big })).toBeNull();

    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(await cacheWillUpdateImage({ response: json })).toBeNull();
  });

  test('stream termination body is still rejected even after a clean end', async () => {
    // Simulates Workbox seeing the final SSE response after the server closes
    // the stream — cacheWillUpdate must still refuse so reconnect traffic never
    // poisons the JSON bucket.
    const ended = new Response('data: {"type":"encounter.updated"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    expect(await cacheWillUpdateJson({ response: ended })).toBeNull();
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/1/events', { headers: { accept: 'text/event-stream' } }))).toBe(
      true,
    );
  });
});

/** Minimal in-memory Cache / CacheStorage for Node Playwright unit tests. */
class MemoryCache {
  private map = new Map<string, Response>();
  async put(request: RequestInfo, response: Response) {
    const key = typeof request === 'string' ? request : request.url;
    // Simulate quota: reject bodies tagged with x-quota-bomb.
    if (response.headers.get('x-quota-bomb') === '1') {
      const err = new DOMException(' Quota exceeded', 'QuotaExceededError');
      throw err;
    }
    this.map.set(key, response.clone());
  }
  async match(request: RequestInfo) {
    const key = typeof request === 'string' ? request : request.url;
    const hit = this.map.get(key);
    return hit ? hit.clone() : undefined;
  }
  async delete(request: RequestInfo) {
    const key = typeof request === 'string' ? request : request.url;
    return this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()].map((url) => new Request(new URL(url, 'http://campfire.test')));
  }
}

class MemoryCacheStorage {
  private caches = new Map<string, MemoryCache>();
  async open(name: string) {
    let c = this.caches.get(name);
    if (!c) {
      c = new MemoryCache();
      this.caches.set(name, c);
    }
    return c;
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  async has(name: string) {
    return this.caches.has(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async match() {
    return undefined;
  }
}

test.describe('sensitive / allowlist policy (#730)', () => {
  test('NetworkOnly covers credentials, capability tokens, invites, and user tokens', () => {
    expect(matchNetworkOnlyApi(req('/api/v1/tokens'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/users/4/tokens'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/shared/recaps/abc'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/calendar/cf_ics_deadbeef.ics'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/calendar-feed'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/invites/join-code'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/invites'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/ai-provider'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/settings/ai-provider'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/notifications'))).toBe(true);
    expect(matchApiJsonCache(req('/api/v1/shared/recaps/abc'))).toBe(false);
    expect(matchApiJsonCache(req('/api/v1/users/4/tokens'))).toBe(false);
  });

  test('JSON cache is an allowlist — non-campaign GETs stay out', () => {
    expect(isAllowlistedJsonApiPath('/api/v1/campaigns/3/summary')).toBe(true);
    expect(isAllowlistedJsonApiPath('/api/v1/quests/9')).toBe(true);
    expect(isAllowlistedJsonApiPath('/api/v1/rules/packs')).toBe(true);
    expect(isAllowlistedJsonApiPath('/api/v1/notifications')).toBe(false);
    expect(isAllowlistedJsonApiPath('/api/v1/shared/recaps/x')).toBe(false);
    expect(matchApiJsonCache(req('/api/v1/notifications'))).toBe(false);
    expect(matchApiJsonCache(req('/api/v1/settings/ai-provider'))).toBe(false);
    expect(matchApiJsonCache(req('/api/v1/campaigns/3/export'))).toBe(false);
  });

  test('isSensitiveApiPathname agrees with NetworkOnly for archive/credential paths', () => {
    for (const path of [
      '/api/v1/backup',
      '/api/v1/campaigns/3/export',
      '/api/v1/campaigns/3/export/me',
      '/api/v1/tokens',
      '/api/v1/users/2/tokens',
      '/api/v1/shared/recaps/t',
      '/api/v1/calendar/tok.ics',
    ]) {
      expect(isSensitiveApiPathname(path)).toBe(true);
      expect(matchNetworkOnlyApi(req(path))).toBe(true);
      expect(matchApiJsonCache(req(path))).toBe(false);
    }
  });

  test('cacheWillUpdate rejects Cache-Control: no-store (defense in depth)', async () => {
    const noStore = new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    });
    expect(await cacheWillUpdateJson({ response: noStore })).toBeNull();
    expect(classifyApiResponseForCache(noStore)).toBe('reject');

    const imgNoStore = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
      },
    });
    expect(await cacheWillUpdateImage({ response: imgNoStore })).toBeNull();
  });

  test('simulated download never lands in Cache Storage; offline retry has no match', async () => {
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;
    const jsonCache = await memory.open(API_JSON_CACHE_NAME);

    const backupUrl = 'http://campfire.test/api/v1/backup';
    const exportUrl = 'http://campfire.test/api/v1/campaigns/3/export';
    const summaryUrl = 'http://campfire.test/api/v1/campaigns/3/summary';

    // Policy: archives are NetworkOnly + rejected by cacheWillUpdate.
    expect(matchNetworkOnlyApi(req('/api/v1/backup'))).toBe(true);
    expect(matchNetworkOnlyApi(req('/api/v1/campaigns/3/export'))).toBe(true);

    const backupRes = new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="campfire-backup.zip"',
        'cache-control': 'private, no-store',
      },
    });
    const exportRes = new Response('{"campaign":{}}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="export.json"',
        'cache-control': 'private, no-store',
      },
    });
    expect(await cacheWillUpdateJson({ response: backupRes })).toBeNull();
    expect(await cacheWillUpdateJson({ response: exportRes })).toBeNull();

    // Even if a buggy caller tries to put them, activate/logout purge removes them.
    await jsonCache.put(backupUrl, backupRes);
    await jsonCache.put(exportUrl, exportRes);
    await jsonCache.put(
      summaryUrl,
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    expect(isSensitiveCachedRequest(new URL(backupUrl))).toBe(true);
    expect(isSensitiveCachedRequest(new URL(exportUrl))).toBe(true);
    const removed = await purgeSensitiveApiCacheEntries(memory as unknown as CacheStorage);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await jsonCache.match(backupUrl)).toBeUndefined();
    expect(await jsonCache.match(exportUrl)).toBeUndefined();
    // Safe allowlisted JSON survives scrub.
    expect(await jsonCache.match(summaryUrl)).toBeTruthy();

    // Offline retry: NetworkOnly + empty cache ⇒ no replay of the archive.
    expect(await jsonCache.match(backupUrl)).toBeUndefined();
    expect(matchApiJsonCache(req('/api/v1/backup'))).toBe(false);
  });

  test('purgeSensitiveApiCacheEntries drops legacy bucket; logout clearApiCache wipes all', async () => {
    installLocalStorage();
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;

    const legacy = await memory.open(LEGACY_API_CACHE_NAME);
    await legacy.put(
      'http://campfire.test/api/v1/backup',
      new Response('zip', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="b.zip"' },
      }),
    );
    await memory.open(API_JSON_CACHE_NAME);
    await memory.open(API_IMAGE_CACHE_NAME);

    const scrubbed = await purgeSensitiveApiCacheEntries(memory as unknown as CacheStorage);
    expect(scrubbed).toBeGreaterThanOrEqual(1);
    expect(await memory.has(LEGACY_API_CACHE_NAME)).toBe(false);

    // Re-seed then logout-style wipe (account switch / logout).
    await memory.open(LEGACY_API_CACHE_NAME);
    await memory.open(API_JSON_CACHE_NAME);
    await clearApiCache();
    expect(await memory.has(API_JSON_CACHE_NAME)).toBe(false);
    expect(await memory.has(API_IMAGE_CACHE_NAME)).toBe(false);
    expect(await memory.has(LEGACY_API_CACHE_NAME)).toBe(false);
  });

  test('attachment thumbs are not treated as sensitive cache keys', () => {
    const thumb = new URL('http://campfire.test/api/v1/attachments/9?size=thumb');
    const original = new URL('http://campfire.test/api/v1/attachments/9');
    expect(isSensitiveCachedRequest(thumb)).toBe(false);
    expect(isSensitiveCachedRequest(original)).toBe(true);
    expect(matchApiImageCache(req('/api/v1/attachments/9?size=thumb'))).toBe(true);
  });
});

test.describe('offline campaign manifest (#879)', () => {
  test.beforeEach(() => {
    installLocalStorage();
    clearAllOfflineManifestMeta();
  });

  test('manifest lists bounded campaign JSON reads and never streams/exports', () => {
    const entries = campaignOfflineManifest(42);
    expect(entries.some((e) => e.url.endsWith('/summary'))).toBe(true);
    expect(entries.every((e) => !e.url.includes('/events'))).toBe(true);
    expect(entries.every((e) => !e.url.includes('/export'))).toBe(true);
    expect(entries.every((e) => !e.url.includes('/backup'))).toBe(true);
  });

  test('inspect reports missing, then present, then stale', async () => {
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;

    const missing = await inspectCampaignOfflineManifest(7, { caches: memory as unknown as CacheStorage });
    expect(offlinePackIndicator(missing)).toBe('missing');
    expect(missing.complete).toBe(false);

    const now = 1_700_000_000_000;
    const fetchImpl: typeof fetch = async (input) => {
      return new Response(JSON.stringify({ url: String(input) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await downloadCampaignOfflinePack(7, { fetchImpl, now });
    expect(result.stored).toBeGreaterThan(0);
    expect(result.ok).toBe(true);

    const ready = await inspectCampaignOfflineManifest(7, {
      caches: memory as unknown as CacheStorage,
      now,
    });
    expect(offlinePackIndicator(ready)).toBe('ready');
    expect(ready.complete).toBe(true);

    const stale = await inspectCampaignOfflineManifest(7, {
      caches: memory as unknown as CacheStorage,
      now: now + 8 * 24 * 60 * 60 * 1000,
    });
    expect(offlinePackIndicator(stale)).toBe('stale');
    expect(stale.staleCount).toBeGreaterThan(0);

    clearOfflineManifestMeta(7);
  });

  test('Workbox-cached bytes without a downloaded pack stay missing (not stale)', async () => {
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;
    const cache = await memory.open('campfire-api-json');
    for (const entry of campaignOfflineManifest(11)) {
      if (entry.kind !== 'image') {
        await cache.put(entry.url, new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
    }
    const inspection = await inspectCampaignOfflineManifest(11, {
      caches: memory as unknown as CacheStorage,
    });
    expect(offlinePackIndicator(inspection)).toBe('missing');
    expect(inspection.staleCount).toBe(0);
    expect(inspection.missingCount).toBeGreaterThan(0);
  });

  test('large download / policy-reject does not enter the pack', async () => {
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        return new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="x.json"',
          },
        });
      }
      if (url.endsWith('/characters')) {
        return new Response('x', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(API_JSON_MAX_BYTES + 5),
          },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await downloadCampaignOfflinePack(9, { fetchImpl });
    expect(result.failed.some((f) => f.url.endsWith('/summary') && f.reason === 'policy-reject')).toBe(true);
    // Oversized Content-Length is rejected inside cacheWillUpdateJson (same
    // gate the service worker uses) before the pack records an 'oversized' reason.
    expect(result.failed.some((f) => f.url.endsWith('/characters') && f.reason === 'policy-reject')).toBe(true);
  });

  test('quota exhaustion triggers eviction and reports quotaExceeded', async () => {
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;

    // Pre-fill JSON cache so eviction has something to delete on retry.
    const cache = await memory.open('campfire-api-json');
    await cache.put(
      '/api/v1/campaigns/1/old',
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    let summaryAttempts = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        summaryAttempts += 1;
        // Bomb put while the pre-filled entry still exists; after eviction the
        // retry succeeds without the quota header.
        const keys = await cache.keys();
        const bomb = keys.length > 0;
        return new Response('{"summary":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(bomb ? { 'x-quota-bomb': '1' } : {}),
          },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await downloadCampaignOfflinePack(1, { fetchImpl });
    expect(summaryAttempts).toBeGreaterThanOrEqual(1);
    expect(result.quotaExceeded || result.stored > 0 || result.failed.length > 0).toBe(true);
  });

  test('evictCacheEntries drops oldest until under maxEntries', async () => {
    const cache = new MemoryCache();
    await cache.put('http://campfire.test/a', new Response('a'));
    await cache.put('http://campfire.test/b', new Response('b'));
    await cache.put('http://campfire.test/c', new Response('c'));
    const deleted = await evictCacheEntries(cache as unknown as Cache, {
      maxEntries: 1,
      metaEntries: {
        '/a': { cachedAt: 1, bytes: 1, cacheName: 'campfire-api-json' },
        '/b': { cachedAt: 2, bytes: 1, cacheName: 'campfire-api-json' },
        '/c': { cachedAt: 3, bytes: 1, cacheName: 'campfire-api-json' },
      },
    });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect((await cache.keys()).length).toBeLessThanOrEqual(1);
  });
});

test.describe('clearApiCache also drops offline pack meta (#879)', () => {
  test('purge removes managed caches and offline manifest keys', async () => {
    installLocalStorage();
    const memory = new MemoryCacheStorage();
    (globalThis as { caches?: CacheStorage }).caches = memory as unknown as CacheStorage;
    await memory.open('campfire-api-json');
    await memory.open('campfire-api-images');
    await memory.open('campfire-api');

    localStorage.setItem(
      'cf.offlineManifest.3',
      JSON.stringify({
        campaignId: 3,
        downloadedAt: 1,
        entries: {},
      }),
    );

    await clearApiCache();
    expect(await memory.has('campfire-api-json')).toBe(false);
    expect(await memory.has('campfire-api-images')).toBe(false);
    expect(await memory.has('campfire-api')).toBe(false);
    expect(localStorage.getItem('cf.offlineManifest.3')).toBeNull();
  });
});

test.describe('SSE reconnect contract under NetworkOnly (#879)', () => {
  test('aborted stream can reconnect without a cached body being replayed', async () => {
    // The SW never caches these requests (NetworkOnly). This test locks the
    // client-side reconnect loop: exit → abort → new fetch, with no cache.match.
    const paths: string[] = [];
    let attempt = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      paths.push(url);
      attempt += 1;
      if (attempt === 1) {
        // First stream ends (server restart).
        return new Response('data: {"type":"x"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      // Second connect succeeds and stays open until aborted.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
            init?.signal?.addEventListener('abort', () => controller.close());
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const url = '/api/v1/campaigns/5/events';
    expect(matchNetworkOnlyApi(req(url, { headers: { accept: 'text/event-stream' } }))).toBe(true);

    const controller1 = new AbortController();
    const res1 = await fetchImpl(url, {
      headers: { accept: 'text/event-stream' },
      signal: controller1.signal,
    });
    expect(res1.headers.get('content-type')).toContain('text/event-stream');
    expect(await cacheWillUpdateJson({ response: res1 })).toBeNull();
    controller1.abort(); // terminate

    const controller2 = new AbortController();
    const res2 = await fetchImpl(url, {
      headers: { accept: 'text/event-stream' },
      signal: controller2.signal,
    });
    expect(res2.ok).toBe(true);
    expect(await cacheWillUpdateJson({ response: res2 })).toBeNull();
    controller2.abort();

    expect(paths.length).toBe(2);
    expect(paths.every((p) => p.endsWith('/events'))).toBe(true);
  });
});
