/**
 * Service-worker runtime-cache housekeeping (issue #268) + offline-identity
 * survival (issue #579).
 *
 * The PWA service worker (see apps/web/vite.config.ts) caches `/api` GETs under a
 * single global bucket so read-only campaign data survives going offline. That
 * bucket is NOT scoped per user, so on a shared device the previous session's (or
 * a pre-seed) responses linger. Under NetworkFirst the live response normally
 * wins, but the moment a request can't reach the network the SW would serve those
 * stale bytes as truth — a since-removed member, an old HP, a quest shown done.
 *
 * We therefore purge this cache at every proven-live auth-identity change (fresh
 * sign-in, account switch, logout). After a purge the first reads simply refill
 * from the live API, so nothing from a prior identity can render as truth for
 * the next.
 *
 * #579 — STALE VS LOGGED OUT: `/me` is excluded from the SW cache (see
 * vite.config.ts) so a successful `/me` is always proven-live. The last-known
 * identity is persisted here, in `localStorage`, SEPARATELY from the SW cache
 * bucket. On an offline reload `/me` fails (not 401 — a real network error), and
 * AuthProvider restores the persisted identity marked `staleIdentity: true` so
 * the UI can render the authed shell with an "offline — showing last-known"
 * banner. The cache is only ever wiped by a proven-live identity change or a
 * real 401 — never by `navigator.onLine`, never by an offline artifact.
 */

/** localStorage key under which the last-known Me snapshot is persisted. */
const ME_SNAPSHOT_KEY = 'cf.meSnapshot';

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

/**
 * Persist the last-known identity so an offline reload can render the authed UI
 * from the SW-cached campaign data instead of bouncing to /login. Only call this
 * from a PROVEN-LIVE /me success (the SW never caches /me itself — see
 * vite.config.ts). Stored as a JSON envelope carrying the identity and the wall
 * clock time it was confirmed live, so the UI can show "last synced …".
 *
 * Storage failures are swallowed: an unsupported/quota-exhausted browser simply
 * loses offline-identity survival, never a feature it relied on.
 */
export function persistMeSnapshot(me: unknown, confirmedAt: number = Date.now()): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ME_SNAPSHOT_KEY, JSON.stringify({ me, confirmedAt }));
  } catch {
    /* private mode / quota — offline identity survival degrades silently. */
  }
}

/** Remove any persisted identity. Called on a proven 401 (real logout / session end). */
export function clearMeSnapshot(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(ME_SNAPSHOT_KEY);
  } catch {
    /* already absent or storage unavailable — nothing to do. */
  }
}

/** Shape persisted by {@link persistMeSnapshot}. `me` is opaque to this module. */
export interface MeSnapshot<T = unknown> {
  me: T;
  confirmedAt: number;
}

/**
 * Read the persisted identity snapshot, or null if none (or unparseable).
 * Returning null for corrupt data is intentional — a malformed snapshot must
 * never render as truth; the caller treats it as "no offline identity available".
 */
export function readMeSnapshot<T = unknown>(): MeSnapshot<T> | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(ME_SNAPSHOT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MeSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    const { me, confirmedAt } = parsed;
    if (typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt)) return null;
    if (me === undefined) return null;
    return { me: me as T, confirmedAt };
  } catch {
    return null;
  }
}
