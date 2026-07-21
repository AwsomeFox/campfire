/**
 * Service-worker runtime-cache housekeeping (issue #268).
 *
 * The PWA service worker (see apps/web/vite.config.ts) caches `/api` GETs under a
 * single global bucket so read-only campaign data survives going offline. That
 * bucket is NOT scoped per user, so on a shared device the previous session's (or
 * a pre-seed) responses linger. Under NetworkFirst the live response normally
 * wins, but the moment a request can't reach the network the SW would serve those
 * stale bytes as truth — a since-removed member, an old HP, a quest shown done.
 *
 * We therefore purge this cache at every auth-identity change (fresh sign-in,
 * account switch, logout). After a purge the first reads simply refill from the
 * live API, so nothing from a prior identity can render as truth for the next.
 */

/**
 * MUST match `cacheName` in the workbox `runtimeCaching` entry in
 * apps/web/vite.config.ts. Kept as a literal (rather than shared) because the
 * Vite config is build-time and this runs in the browser.
 */
const API_CACHE_NAME = 'campfire-api';

/**
 * Delete the SW's cached `/api` GET responses. Best-effort and safe to call when
 * no service worker / Cache Storage exists (dev, unsupported browsers): it
 * resolves silently rather than throwing, so it can never block sign-in or logout.
 */
export async function clearApiCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await caches.delete(API_CACHE_NAME);
  } catch {
    // Purging the cache is defensive hygiene, never a hard dependency of auth.
  }
}
