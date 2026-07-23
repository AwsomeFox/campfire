/**
 * Service-worker runtime-cache housekeeping (issue #268) + offline-identity
 * survival (issue #579) + restore-safety namespacing (issue #723) + bounded
 * cache buckets (issue #879).
 *
 * The PWA service worker (see apps/web/vite.config.ts) caches safe `/api` JSON
 * GETs (and optional attachment thumbs) under bounded global buckets so
 * read-only campaign data survives going offline. Those buckets are NOT scoped
 * per user, so on a shared device the previous session's (or a pre-seed)
 * responses linger. Under NetworkFirst the live response normally wins, but the
 * moment a request can't reach the network the SW would serve those stale bytes
 * as truth — a since-removed member, an old HP, a quest shown done.
 *
 * We therefore purge these caches at every proven-live auth-identity change
 * (fresh sign-in, account switch, logout). After a purge the first reads simply
 * refill from the live API, so nothing from a prior identity can render as truth
 * for the next.
 *
 * #579 — STALE VS LOGGED OUT: `/me` is excluded from the SW cache (see
 * vite.config.ts) so a successful `/me` is always proven-live. The last-known
 * identity is persisted here, in `localStorage`, SEPARATELY from the SW cache
 * bucket. On an offline reload `/me` fails (not 401 — a real network error), and
 * AuthProvider restores the persisted identity marked `staleIdentity: true` so
 * the UI can render the authed shell with an "offline — showing last-known"
 * banner. The cache is only ever wiped by a proven-live identity change or a
 * real 401 — never by `navigator.onLine`, never by an offline artifact.
 *
 * #723 — RESTORE SAFETY: a whole-server backup restore reuses the same numeric
 * user/campaign IDs but swaps the entire dataset underneath. The SW cache is
 * keyed only by URL, so without a generation signal a cached `/api/v1/campaigns/3`
 * would serve PRE-restore bytes offline after a restore. The server now carries
 * a per-install UUID + a monotonic `dataGeneration` (bumped on every restore) on
 * `/me` as `Me.instance`. Because `/me` is uncached + proven-live (see above),
 * the client learns the CURRENT generation from a response that never came from
 * the SW cache. The persisted Me snapshot (below) records the generation its
 * cached responses were populated against — and AuthProvider compares the live
 * generation to that on every `/me`, wiping the cache the moment they diverge
 * (see authDecision.ts). The wipe uses the same `clearApiCache()` path as an
 * identity change, so a restore invalidates stale bytes exactly the way an
 * account switch does. Cache Storage is origin-wide, so one tab's wipe clears
 * the SW cache for EVERY tab; {@link subscribeToCachePurges} additionally fans
 * the wipe out to other tabs' in-memory (React Query) caches via BroadcastChannel
 * so they don't keep rendering stale data until their own next `/me`.
 */

import type { ServerInstance } from '@campfire/schema';
import { clearAllOfflineManifestMeta } from './offlineCampaignManifest';
import { MANAGED_API_CACHE_NAMES } from './pwaCachePolicy';

/** localStorage key under which the last-known Me snapshot is persisted. */
const ME_SNAPSHOT_KEY = 'cf.meSnapshot';

/**
 * BroadcastChannel name used to fan a cache purge out to OTHER tabs of the same
 * origin (issue #723 cross-tab criterion). The SW's Cache Storage is shared
 * origin-wide, so {@link clearApiCache} already empties it for every tab the
 * instant any one tab calls it — but each tab's React Query cache is in-memory
 * and per-tab. This channel lets the tab that detected the generation/identity
 * change tell every other tab to drop its in-memory cache too, so nothing keeps
 * rendering pre-restore data while waiting for the next `/me`.
 */
const CACHE_PURGE_CHANNEL = 'cf.cache-purge';

/**
 * Structural equality over a {@link ServerInstance}. Two identities match only
 * when BOTH the install UUID and the (monotonic) data generation match — a
 * restore leaves the UUID alone (it lives inside the restored DB) but bumps the
 * generation, so a post-restore `/me` always mismatches the pre-restore snapshot
 * here. Null/undefined inputs never match (a legacy snapshot persisted before
 * #723 has no instance, which we treat as "generation unknown" → always mismatch
 * → wipe on the next live `/me`, the safe direction).
 */
export function sameDataIdentity(
  a: ServerInstance | null | undefined,
  b: ServerInstance | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.instanceId === b.instanceId && a.dataGeneration === b.dataGeneration;
}

/**
 * A stable string token for a {@link ServerInstance} (`<uuid>#<generation>`),
 * useful for logging or as a map key. Two identities with the same token are
 * the same data generation (see {@link sameDataIdentity}).
 */
export function dataIdentityToken(instance: ServerInstance): string {
  return `${instance.instanceId}#${instance.dataGeneration}`;
}

/**
 * Best-effort BroadcastChannel for {@link CACHE_PURGE_CHANNEL}, or null when the
 * environment has no BroadcastChannel (older browsers, the Playwright Node test
 * process). Kept lazy + guarded so callers never throw on unsupported envs.
 */
function openPurgeChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CACHE_PURGE_CHANNEL);
  } catch {
    return null;
  }
}

/**
 * Delete the SW's cached `/api` GET responses. Best-effort and safe to call when
 * no service worker / Cache Storage exists (dev, unsupported browsers): it
 * resolves silently rather than throwing, so it can never block sign-in or logout.
 *
 * #723: ALSO posts a purge notification on {@link CACHE_PURGE_CHANNEL} so other
 * tabs of this origin drop their IN-MEMORY (React Query) caches. The SW Cache
 * Storage deletion above is already origin-wide (one tab's delete empties it for
 * all), but React Query state lives per-tab; the broadcast makes the cross-tab
 * purge immediate instead of waiting for each tab's next `/me` to notice.
 */
export async function clearApiCache(): Promise<void> {
  if (typeof globalThis.caches !== 'undefined') {
    // Wipe JSON + image buckets and the pre-#879 legacy name so an upgraded
    // worker cannot leave sensitive export/backup entries behind after logout.
    for (const name of MANAGED_API_CACHE_NAMES) {
      try {
        await globalThis.caches.delete(name);
      } catch {
        // Purging the cache is defensive hygiene, never a hard dependency of auth.
      }
    }
  }
  // Offline-pack bookkeeping is identity-scoped too — drop it with the caches so
  // a later account never inherits "ready" indicators for another user's pack.
  clearAllOfflineManifestMeta();
  // Fan the purge out to other tabs AFTER the shared SW cache is cleared, so a
  // peer that reacts by refetching reads from the network into an empty cache
  // rather than re-poisoning a just-cleared one. Best-effort: a peer with no
  // BroadcastChannel simply falls back to its own next /me detecting the change.
  const channel = openPurgeChannel();
  if (channel) {
    try {
      channel.postMessage('purge');
    } catch {
      /* a closed peer channel is not an error */
    } finally {
      channel.close();
    }
  }
}

/**
 * Register a callback invoked when ANOTHER tab of this origin clears the API
 * cache (via {@link clearApiCache}'s broadcast). Returns an unsubscribe. Used by
 * AuthProvider to drop its own (per-tab, in-memory) React Query cache on a
 * peer-initiated purge so it doesn't keep rendering stale data. Safe to call in
 * environments without BroadcastChannel: the callback simply never fires, and
 * the returned unsubscribe is a no-op.
 */
export function subscribeToCachePurges(cb: () => void): () => void {
  const channel = openPurgeChannel();
  if (!channel) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.data === 'purge') cb();
  };
  channel.addEventListener('message', listener);
  // Keep the channel open for the lifetime of the subscription (unlike
  // clearApiCache, which opens/closes per call). Return a closer that detaches
  // the listener AND closes the channel so a tab unmount doesn't leak it.
  return () => {
    try {
      channel.removeEventListener('message', listener);
      channel.close();
    } catch {
      /* already closed — nothing to do */
    }
  };
}

/**
 * Persist the last-known identity so an offline reload can render the authed UI
 * from the SW-cached campaign data instead of bouncing to /login. Only call this
 * from a PROVEN-LIVE /me success (the SW never caches /me itself — see
 * vite.config.ts). Stored as a JSON envelope carrying the identity, the wall
 * clock time it was confirmed live (so the UI can show "last synced …"), and the
 * server's data-generation identity at confirm time.
 *
 * #723: the persisted `instance` is the generation the SW cache was populated
 * AGAINST. The next proven-live `/me` carries the server's CURRENT generation;
 * AuthProvider compares the two and wipes the cache if they differ (a restore
 * bumped the server's). An offline reload uses the persisted `instance` purely
 * for the stale banner/identity restore — it never re-serves cached bytes
 * uncritically, because NetworkFirst still prefers the network whenever it can
 * be reached, and the next online `/me` re-validates the generation.
 *
 * Storage failures are swallowed: an unsupported/quota-exhausted browser simply
 * loses offline-identity survival, never a feature it relied on.
 *
 * `instance` is optional only for a transitional caller that has a `me` but not
 * yet an instance; a persisted snapshot without one is treated as "generation
 * unknown" on read, which forces a wipe on the next live `/me` (safe direction).
 */
export function persistMeSnapshot(
  me: unknown,
  confirmedAt: number = Date.now(),
  instance?: ServerInstance | null,
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: MeSnapshot = { me, confirmedAt };
    if (instance) envelope.instance = instance;
    localStorage.setItem(ME_SNAPSHOT_KEY, JSON.stringify(envelope));
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

/**
 * Shape persisted by {@link persistMeSnapshot}. `me` is opaque to this module.
 * `instance` is the server data-generation identity at persist time (issue #723)
 * — present on snapshots persisted after #723; absent (null on read) on older
 * ones, which AuthProvider treats as "generation unknown" → wipe on next /me.
 */
export interface MeSnapshot<T = unknown> {
  me: T;
  confirmedAt: number;
  instance?: ServerInstance;
}

/**
 * Read the persisted identity snapshot, or null if none (or unparseable).
 * Returning null for corrupt data is intentional — a malformed snapshot must
 * never render as truth; the caller treats it as "no offline identity available".
 *
 * #723: `instance` is validated (instanceId must be a non-empty string,
 * dataGeneration a finite non-negative integer) before it's returned; a snapshot
 * with a malformed or partial instance has it dropped to undefined, which
 * AuthProvider interprets as "generation unknown" and wipes the cache on the
 * next live `/me`. A snapshot persisted before #723 (no instance field) reads
 * back with `instance === undefined` for the same reason — safe direction.
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
    const { me, confirmedAt, instance } = parsed;
    if (typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt)) return null;
    if (me === undefined) return null;
    // Validate the instance envelope defensively — a corrupt generation must
    // never be rendered as truth. On any validation failure we DROP it rather
    // than discard the whole snapshot: the offline identity (me/confirmedAt) is
    // still useful, and a missing instance simply forces a wipe on next live /me.
    const validInstance = isValidInstance(instance) ? instance : undefined;
    return { me: me as T, confirmedAt, ...(validInstance ? { instance: validInstance } : {}) };
  } catch {
    return null;
  }
}

/** Defensive structural check for a persisted {@link ServerInstance}. */
function isValidInstance(value: unknown): value is ServerInstance {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.instanceId === 'string' && v.instanceId.length > 0 &&
    typeof v.dataGeneration === 'number' && Number.isInteger(v.dataGeneration) && v.dataGeneration >= 0
  );
}
