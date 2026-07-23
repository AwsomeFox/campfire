/**
 * Compendium browse a11y vocabulary + URL filter helpers (issue #647).
 *
 * Kept as plain strings/helpers so unit specs can pin accessible names,
 * live-region copy, and search-param round-trips without mounting the page.
 */

/** Stable id for the search field — paired with htmlFor on the visible label. */
export const COMPENDIUM_SEARCH_ID = 'compendium-search';

/** Persistent accessible name for the search field (not placeholder-only). */
export const COMPENDIUM_SEARCH_LABEL = 'Search the compendium';

/** Named group label for the single-select type filter chips. */
export const COMPENDIUM_TYPE_FILTER_LABEL = 'Entry type';

/** Control that resets search text and type filter together. */
export const COMPENDIUM_CLEAR_FILTERS_LABEL = 'Clear filters';

/** Browser URL keys for Compendium search / type filters / pagination (issue #613). */
export const COMPENDIUM_URL_Q = 'q';
export const COMPENDIUM_URL_TYPE = 'type';
/** Opaque server cursor — present when the list starts mid-result-set (paged browse). */
export const COMPENDIUM_URL_CURSOR = 'cursor';

export const COMPENDIUM_LOAD_MORE_LABEL = 'Load more';

/** Type-chip values that may appear in `?type=` (excludes the default "all"). */
export const COMPENDIUM_URL_TYPE_VALUES = [
  'spell',
  'monster',
  'item',
  'condition',
  'class',
  'race',
  'feat',
] as const;

export type CompendiumUrlType = (typeof COMPENDIUM_URL_TYPE_VALUES)[number] | 'all';

export function parseCompendiumTypeParam(raw: string | null | undefined): CompendiumUrlType {
  if (!raw || raw === 'all') return 'all';
  return (COMPENDIUM_URL_TYPE_VALUES as readonly string[]).includes(raw)
    ? (raw as CompendiumUrlType)
    : 'all';
}

/** Merge `q` / `type` / optional `cursor` into existing search params (omit defaults). */
export function applyCompendiumSearchParams(
  prev: URLSearchParams,
  opts: { q: string; type: CompendiumUrlType; cursor?: string | null },
): URLSearchParams {
  const next = new URLSearchParams(prev);
  const trimmed = opts.q.trim();
  if (trimmed) next.set(COMPENDIUM_URL_Q, trimmed);
  else next.delete(COMPENDIUM_URL_Q);
  if (opts.type !== 'all') next.set(COMPENDIUM_URL_TYPE, opts.type);
  else next.delete(COMPENDIUM_URL_TYPE);
  // Changing filters clears pagination; only set cursor when explicitly provided.
  if (opts.cursor) next.set(COMPENDIUM_URL_CURSOR, opts.cursor);
  else next.delete(COMPENDIUM_URL_CURSOR);
  return next;
}

/**
 * Query used for fetch + live status.
 *
 * Keystrokes keep using the debounced draft. When URL `q` changes from outside
 * the typing path (navigation, history, clearFilters), snap to the committed
 * URL value immediately so search does not lag ~300ms behind the field/URL.
 */
export function effectiveCompendiumSearchQuery(opts: {
  draftQuery: string;
  committedQuery: string;
  debouncedQuery: string;
  /** True on the render where URL `q` changed vs the previous committed value. */
  urlQueryChanged: boolean;
}): string {
  // Trim both sides so padded URL `q` values match the draft the same way
  // CompendiumPage trims before writing search params.
  if (opts.urlQueryChanged || opts.draftQuery.trim() === opts.committedQuery.trim()) {
    return opts.committedQuery;
  }
  return opts.debouncedQuery;
}

export function compendiumResultsStatus(opts: {
  loading: boolean;
  resultCount: number | null;
  query: string;
  typeKey: string;
  typeLabel: string;
  /** Search request failed — suppress empty/count copy (ErrorNote is the alert). */
  failed?: boolean;
  /** Total matches available server-side (issue #613); may exceed loaded `resultCount`. */
  totalCount?: number | null;
  hasMore?: boolean;
}): string {
  const q = opts.query.trim();
  if (opts.loading) return 'Searching the compendium…';
  // Failure is announced via ErrorNote (role="alert"); do not also claim "no results".
  if (opts.failed) return '';
  if (opts.resultCount == null) return '';
  if (opts.resultCount === 0) {
    if (q) {
      return opts.typeKey !== 'all'
        ? `No results for “${q}” in ${opts.typeLabel}.`
        : `No results for “${q}”.`;
    }
    if (opts.typeKey !== 'all') {
      return `No ${opts.typeLabel.toLowerCase()} in this rule system.`;
    }
    return 'No entries in this rule system.';
  }
  const loaded = opts.resultCount;
  const total = opts.totalCount != null && opts.totalCount > loaded ? opts.totalCount : null;
  const noun = loaded === 1 ? 'result' : 'results';
  const countPart =
    total != null
      ? `Showing ${loaded} of ${total} ${total === 1 ? 'result' : 'results'}`
      : `${loaded} ${noun}`;
  const more = opts.hasMore ? ' More available.' : '';
  if (q && opts.typeKey !== 'all') {
    return `${countPart} for “${q}” in ${opts.typeLabel}.${more}`;
  }
  if (q) return `${countPart} for “${q}”.${more}`;
  if (opts.typeKey !== 'all') {
    return `${countPart} in ${opts.typeLabel}.${more}`;
  }
  return `${countPart}.${more}`;
}
