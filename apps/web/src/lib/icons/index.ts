/**
 * Bundled entity-icon library (issue #302; full-set lazy loading issue #349).
 *
 * A curated, offline set of ~180 game-icons.net RPG icons (CC BY 3.0) ships
 * inline for zero-latency rendering — that data lives in `catalog.generated.ts`
 * and is exported synchronously below (`ICON_CATALOG`/`getIcon`/`searchIcons`).
 *
 * The FULL game-icons.net set (~4,130 icons after collapsing filename
 * collisions across contributors) is also reachable, but lazily: its metadata
 * (`fullIndex.generated.ts` — slug/name/artist, no svg bodies) is only ever
 * `import()`-ed on demand (see `loadFullIconIndex` below), and the svg bodies
 * live as static JSON shards under `/icons/shards/shard-NNN.json`, fetched
 * (and cached in memory) only for icons actually rendered or searched. Neither
 * is a static import anywhere in this module, so Vite code-splits both away
 * from the main bundle and from the curated chunk.
 *
 * `resolveIcon(slug)` is the async counterpart to `getIcon(slug)`: it checks
 * the curated set first (instant), then falls back to the lazy full-set path.
 * `<GameIcon>` uses it internally so every consumer (NPCs, compendium,
 * inventory) can render any of the ~4,130 icons by slug, not just the picker.
 */
import {
  ICON_CATALOG,
  ICON_ARTISTS,
  ICON_ARTIST_TOTAL_COUNTS,
  ICON_LICENSE,
  ICON_SOURCE_NAME,
  ICON_SOURCE_URL,
  ICON_VIEWBOX,
  TOTAL_ICON_COUNT,
  type GameIconEntry,
  type IconArtist,
} from './catalog.generated';
import type { FullIconIndexEntry } from './fullIndex.generated';
import { UI_EXTRA_ICONS } from './uiExtras.generated';

export {
  ICON_CATALOG,
  ICON_ARTISTS,
  ICON_ARTIST_TOTAL_COUNTS,
  ICON_LICENSE,
  ICON_SOURCE_NAME,
  ICON_SOURCE_URL,
  ICON_VIEWBOX,
  TOTAL_ICON_COUNT,
};
export type { GameIconEntry, IconArtist, FullIconIndexEntry };

/**
 * O(1) slug → entry lookup for everything that resolves synchronously, built once
 * at module load: the curated catalog plus the always-bundled high-frequency chrome
 * icons (`uiExtras.generated`, so nav/chips/guards paint on first render instead of
 * awaiting a shard fetch). The picker's curated set (`ICON_CATALOG`/`searchIcons`)
 * is unchanged — these extras just render instantly wherever their slug is used.
 */
const BY_SLUG: ReadonlyMap<string, GameIconEntry> = new Map(
  [...ICON_CATALOG, ...UI_EXTRA_ICONS].map((e) => [e.slug, e]),
);

/** Distinct categories in catalog order (stable), for the picker's filter chips. */
export const ICON_CATEGORIES: readonly string[] = Array.from(
  new Set(ICON_CATALOG.map((e) => e.category)),
);

/** Number of icons in the curated, instant-render set. */
export const ICON_COUNT = ICON_CATALOG.length;

/** Look up a single CURATED icon by slug (synchronous), or undefined if not curated. */
export function getIcon(slug: string | null | undefined): GameIconEntry | undefined {
  if (!slug) return undefined;
  return BY_SLUG.get(slug);
}

/** True when `slug` names an icon in the curated (instant-render) catalog. */
export function isKnownIcon(slug: string | null | undefined): boolean {
  return !!slug && BY_SLUG.has(slug);
}

/**
 * Search the CURATED catalog by free-text query and/or category. Query matches
 * the display name, slug, and tags (case-insensitive, all whitespace-separated
 * terms must match somewhere). An empty query returns the whole (optionally
 * category-filtered) set in catalog order so the picker always shows something.
 */
export function searchIcons(query = '', category = ''): GameIconEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return ICON_CATALOG.filter((e) => {
    if (category && e.category !== category) return false;
    if (terms.length === 0) return true;
    const haystack = `${e.name} ${e.slug} ${e.category} ${e.tags.join(' ')}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

// ---------------------------------------------------------------------------
// Full-set lazy loading (issue #349)
// ---------------------------------------------------------------------------

/** Memoized dynamic import of the full-set metadata (slug/name/artist/shard). */
let fullIndexPromise: Promise<readonly FullIconIndexEntry[]> | null = null;

/**
 * Loads (once) and returns the full ~4,130-icon metadata index. Safe to call
 * repeatedly — every caller shares the one in-flight/resolved import(). This
 * is the only thing that pulls in `fullIndex.generated.ts`, so it stays a
 * separate chunk untouched by the main bundle until something actually needs
 * it (the picker opening, or a non-curated slug being rendered anywhere).
 */
export function loadFullIconIndex(): Promise<readonly FullIconIndexEntry[]> {
  if (!fullIndexPromise) {
    fullIndexPromise = import('./fullIndex.generated')
      .then((mod) => mod.FULL_ICON_INDEX)
      .catch((err) => {
        fullIndexPromise = null; // allow retry (e.g. after a transient offline failure)
        throw err;
      });
  }
  return fullIndexPromise;
}

let fullIndexMapPromise: Promise<ReadonlyMap<string, FullIconIndexEntry>> | null = null;

function loadFullIconIndexMap(): Promise<ReadonlyMap<string, FullIconIndexEntry>> {
  if (!fullIndexMapPromise) {
    fullIndexMapPromise = loadFullIconIndex()
      .then((entries) => new Map(entries.map((e) => [e.slug, e])))
      .catch((err) => {
        fullIndexMapPromise = null;
        throw err;
      });
  }
  return fullIndexMapPromise;
}

/** In-flight/resolved shard fetches, keyed by shard index — dedupes concurrent requests. */
const shardPromises = new Map<number, Promise<Record<string, string>>>();
/** slug -> already-fetched svg body, populated as shards land (any icon in a fetched shard is free). */
const shardBodyCache = new Map<string, string>();

function loadShard(shard: number): Promise<Record<string, string>> {
  let p = shardPromises.get(shard);
  if (!p) {
    const file = `/icons/shards/shard-${String(shard).padStart(3, '0')}.json`;
    p = fetch(file)
      .then((res) => {
        if (!res.ok) throw new Error(`icon shard ${shard} fetch failed: HTTP ${res.status}`);
        return res.json() as Promise<Record<string, string>>;
      })
      .then((body) => {
        for (const [slug, svg] of Object.entries(body)) shardBodyCache.set(slug, svg);
        return body;
      })
      .catch((err) => {
        shardPromises.delete(shard); // don't poison the cache — a later render can retry
        throw err;
      });
    shardPromises.set(shard, p);
  }
  return p;
}

/** Fully-resolved (metadata + body) full-set entries, cached by slug once resolved. */
const resolvedCache = new Map<string, GameIconEntry>();

/**
 * Synchronous, no-network lookup across everything already in memory: the curated
 * catalog first, then any full-set icon a prior `resolveIcon` has cached (fully
 * resolved, or just its body from a fetched shard). Returns undefined when nothing
 * is cached yet — callers fall back to the async `resolveIcon`. Lets `<GameIcon>`
 * paint a previously-seen non-curated slug on the very first render (no flicker on
 * remount for frequently-shown chrome), instead of only curated slugs.
 */
export function getCachedIcon(slug: string | null | undefined): GameIconEntry | undefined {
  if (!slug) return undefined;
  const curated = BY_SLUG.get(slug);
  if (curated) return curated;
  const resolved = resolvedCache.get(slug);
  if (resolved) return resolved;
  const body = shardBodyCache.get(slug);
  if (body) return { slug, name: slug, category: '', artist: '', tags: [], body };
  return undefined;
}

/**
 * Async counterpart to `getIcon`: resolves ANY icon in the full ~4,130-icon
 * set by slug, not just the curated one. Curated slugs resolve instantly
 * (no network); non-curated slugs trigger (deduped, cached) fetches of the
 * full-set index and the relevant body shard. Resolves to `undefined` for an
 * unknown slug, or if the index/shard fetch fails (e.g. offline and
 * uncached) — callers should degrade gracefully, same as an unknown slug.
 */
export async function resolveIcon(slug: string | null | undefined): Promise<GameIconEntry | undefined> {
  if (!slug) return undefined;

  const curated = getIcon(slug);
  if (curated) return curated;

  const cached = resolvedCache.get(slug);
  if (cached) return cached;

  const cachedBody = shardBodyCache.get(slug);
  if (cachedBody) {
    // We don't know this slug's name/artist/category without the index, but a
    // just-fetched shard almost always means the index already loaded too.
    const idx = await loadFullIconIndexMap().catch(() => null);
    const meta = idx?.get(slug);
    const entry: GameIconEntry = {
      slug,
      name: meta?.name ?? slug,
      category: meta?.category ?? '',
      artist: meta?.artist ?? '',
      tags: [],
      body: cachedBody,
    };
    resolvedCache.set(slug, entry);
    return entry;
  }

  let indexMap: ReadonlyMap<string, FullIconIndexEntry>;
  try {
    indexMap = await loadFullIconIndexMap();
  } catch {
    return undefined;
  }
  const meta = indexMap.get(slug);
  if (!meta) return undefined;

  let shardBody: Record<string, string>;
  try {
    shardBody = await loadShard(meta.shard);
  } catch {
    return undefined;
  }
  const body = shardBody[slug];
  if (!body) return undefined;

  const entry: GameIconEntry = {
    slug: meta.slug,
    name: meta.name,
    category: meta.category,
    artist: meta.artist,
    tags: [],
    body,
  };
  resolvedCache.set(slug, entry);
  return entry;
}

/**
 * Search the FULL metadata index (must already be loaded — see
 * `loadFullIconIndex`) by the same free-text term matching as `searchIcons`.
 * No svg bodies here; `<GameIcon>`/`resolveIcon` fetch those lazily per
 * rendered result. `limit` caps the result count (default 240) so opening the
 * picker on a broad/empty query doesn't mount thousands of tiles at once —
 * each rendered tile still triggers its own (shard-deduped) body fetch, so
 * this keeps that fan-out bounded.
 */
export function searchFullIconIndex(
  entries: readonly FullIconIndexEntry[],
  query = '',
  category = '',
  limit = 240,
): FullIconIndexEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: FullIconIndexEntry[] = [];
  for (const e of entries) {
    if (category && e.category !== category) continue;
    if (terms.length > 0) {
      const haystack = `${e.name} ${e.slug} ${e.category} ${e.artist}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
