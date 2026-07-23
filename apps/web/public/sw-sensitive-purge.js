/**
 * Service-worker activate purge for sensitive / legacy API caches (issue #730).
 *
 * Loaded via workbox `importScripts` from vite.config.ts. Keep pathname
 * heuristics aligned with apps/web/src/lib/pwaCachePolicy.ts
 * (`isSensitiveCachedRequest` / `LEGACY_API_CACHE_NAME`).
 */
/* eslint-disable no-restricted-globals */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const LEGACY = 'campfire-api';
      const JSON_CACHE = 'campfire-api-json';
      const IMAGE_CACHE = 'campfire-api-images';

      const isSensitive = (urlString) => {
        let url;
        try {
          url = new URL(urlString);
        } catch {
          return false;
        }
        const path = url.pathname;
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
        if (path.startsWith('/api/v1/attachments/') && url.searchParams.get('size') !== 'thumb') {
          return true;
        }
        return false;
      };

      try {
        await caches.delete(LEGACY);
      } catch {
        /* best-effort */
      }

      for (const name of [JSON_CACHE, IMAGE_CACHE]) {
        let cache;
        try {
          if (!(await caches.has(name))) continue;
          cache = await caches.open(name);
        } catch {
          continue;
        }
        let keys;
        try {
          keys = await cache.keys();
        } catch {
          continue;
        }
        await Promise.all(
          keys.map(async (request) => {
            if (isSensitive(request.url)) {
              try {
                await cache.delete(request);
              } catch {
                /* best-effort */
              }
            }
          }),
        );
      }
    })(),
  );
});
