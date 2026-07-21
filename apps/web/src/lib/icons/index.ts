/**
 * Bundled entity-icon library (issue #302).
 *
 * A curated, offline set of game-icons.net RPG icons (CC BY 3.0) that entities
 * can use for an on-theme icon without hand-uploading art. The generated data
 * lives in `catalog.generated.ts`; this module is the searchable public API the
 * picker and any consumer (NPCs today; compendium/#305 and inventory/#307 next)
 * build on.
 *
 * Icons are stored as recolorable inner SVG (`body`, no background) and rendered
 * with `fill: currentColor` by the <GameIcon> component, so an icon inherits the
 * surrounding text colour and needs no per-icon styling.
 */
import {
  ICON_CATALOG,
  ICON_ARTISTS,
  ICON_LICENSE,
  ICON_SOURCE_NAME,
  ICON_SOURCE_URL,
  ICON_VIEWBOX,
  type GameIconEntry,
  type IconArtist,
} from './catalog.generated';

export {
  ICON_CATALOG,
  ICON_ARTISTS,
  ICON_LICENSE,
  ICON_SOURCE_NAME,
  ICON_SOURCE_URL,
  ICON_VIEWBOX,
};
export type { GameIconEntry, IconArtist };

/** O(1) slug → entry lookup, built once at module load. */
const BY_SLUG: ReadonlyMap<string, GameIconEntry> = new Map(
  ICON_CATALOG.map((e) => [e.slug, e]),
);

/** Distinct categories in catalog order (stable), for the picker's filter chips. */
export const ICON_CATEGORIES: readonly string[] = Array.from(
  new Set(ICON_CATALOG.map((e) => e.category)),
);

/** Total number of bundled icons. */
export const ICON_COUNT = ICON_CATALOG.length;

/** Look up a single icon by slug, or undefined if it isn't in the bundled set. */
export function getIcon(slug: string | null | undefined): GameIconEntry | undefined {
  if (!slug) return undefined;
  return BY_SLUG.get(slug);
}

/** True when `slug` names an icon in the bundled catalog. */
export function isKnownIcon(slug: string | null | undefined): boolean {
  return !!slug && BY_SLUG.has(slug);
}

/**
 * Search the catalog by free-text query and/or category. Query matches the
 * display name, slug, and tags (case-insensitive, all whitespace-separated
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
