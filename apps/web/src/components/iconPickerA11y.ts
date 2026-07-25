/**
 * IconPicker a11y vocabulary + pure UX helpers (issue #648).
 *
 * Kept free of React/DOM so category semantics, pinned-current logic, result
 * counts, and recent-icon storage can be pinned in `.unit.spec.ts` without
 * mounting the dialog.
 */

import type { FullIconIndexEntry } from '../lib/icons';
import type { IconPickerSurfaceState } from './iconPickerState';
import { FULL_LIBRARY_SEARCHING_MESSAGE } from './iconPickerState';

/** Named group label for the single-select category filter chips. */
export const ICON_PICKER_CATEGORY_FILTER_LABEL = 'Icon category';

/** Pinned current-selection region — keeps the active icon visible above the grid. */
export const ICON_PICKER_CURRENT_LABEL = 'Current icon';

/** Focus the search field to pick a different icon from the catalog. */
export const ICON_PICKER_REPLACE_LABEL = 'Replace';

/** Revert to the automatic (context-derived) icon when an override is set. */
export const ICON_PICKER_AUTO_LABEL = 'Auto';

/** Remove the explicit icon selection (no icon / auto when applicable). */
export const ICON_PICKER_CLEAR_LABEL = 'Clear';

/** Section heading for recently chosen icons. */
export const ICON_PICKER_RECENT_LABEL = 'Recent icons';

/** Section heading for caller-supplied contextual suggestions. */
export const ICON_PICKER_SUGGESTED_LABEL = 'Suggested icons';

export const ICON_PICKER_RECENT_STORAGE_KEY = 'cf.iconPicker.recent';
export const ICON_PICKER_RECENT_MAX = 8;

export const ICON_PICKER_RESULT_LIMIT = 240;

/** Stable radiogroup keys: `all` + bundled catalog categories (issue #648). */
export function iconPickerCategoryKeys(categories: readonly string[]): readonly string[] {
  return ['all', ...categories];
}

export function iconPickerCategoryValue(key: string): string {
  return key === 'all' ? '' : key;
}

export function iconPickerCategoryChipLabel(key: string): string {
  if (key === 'all') return 'All';
  return key
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Slug shown in the pinned-current row: explicit `value` wins; otherwise the
 * auto-derived slug when the picker is in inventory-style auto mode.
 */
export function iconPickerPinnedSlug(value: string, autoSlug?: string): string | null {
  const explicit = value.trim();
  if (explicit) return explicit;
  const auto = autoSlug?.trim();
  if (auto) return auto;
  return null;
}

/** True when the pinned row reflects auto mode (no explicit override). */
export function iconPickerPinnedIsAuto(value: string, autoSlug?: string): boolean {
  return !value.trim() && !!autoSlug?.trim();
}

/** Drop the pinned slug from the scrollable grid so it is not announced twice. */
export function iconPickerGridResults<T extends { slug: string }>(
  results: readonly T[],
  pinnedSlug: string | null,
): T[] {
  if (!pinnedSlug) return [...results];
  return results.filter((r) => r.slug !== pinnedSlug);
}

export function shouldShowIconPickerAutoAction(value: string, autoSlug?: string): boolean {
  return !!value.trim() && !!autoSlug?.trim();
}

export function shouldShowIconPickerClearAction(value: string, autoSlug?: string): boolean {
  return !!value.trim() && !autoSlug?.trim();
}

/** Hide the grid "None" tile in inventory auto mode; Auto action covers revert. */
export function shouldShowIconPickerNoneTile(autoSlug?: string): boolean {
  return !autoSlug?.trim();
}

/** Merge recent + contextual suggestions, preserving order and deduping. */
export function iconPickerSuggestionSlugs(
  recent: readonly string[],
  contextual: readonly string[] | undefined,
  limit = 12,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slug of [...(contextual ?? []), ...recent]) {
    const trimmed = slug.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

export function readRecentIconPickerSlugs(
  storage: Pick<Storage, 'getItem'> = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null },
): string[] {
  try {
    const raw = storage.getItem(ICON_PICKER_RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  } catch {
    return [];
  }
}

export function recordRecentIconPickerSlug(
  slug: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {} },
): void {
  const trimmed = slug.trim();
  if (!trimmed) return;
  const prev = readRecentIconPickerSlugs(storage).filter((s) => s !== trimmed);
  const next = [trimmed, ...prev].slice(0, ICON_PICKER_RECENT_MAX);
  try {
    storage.setItem(ICON_PICKER_RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota/offline — recent suggestions are best-effort.
  }
}

/** Count full-index matches excluding slugs already in the curated result set. */
export function countFullIconIndexMatches(
  entries: readonly FullIconIndexEntry[],
  query = '',
  category = '',
  excludeSlugs: ReadonlySet<string> = new Set(),
): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let count = 0;
  for (const e of entries) {
    if (excludeSlugs.has(e.slug)) continue;
    if (category && e.category !== category) continue;
    if (terms.length > 0) {
      const haystack = `${e.name} ${e.slug} ${e.category} ${e.artist}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;
    }
    count += 1;
  }
  return count;
}

export function iconPickerTotalMatchCount(opts: {
  curatedCount: number;
  curatedSlugs: ReadonlySet<string>;
  fullIndex: readonly FullIconIndexEntry[] | null | undefined;
  query: string;
  category: string;
}): number | null {
  if (opts.fullIndex === undefined) return null;
  if (opts.fullIndex === null) return opts.curatedCount;
  return opts.curatedCount + countFullIconIndexMatches(opts.fullIndex, opts.query, opts.category, opts.curatedSlugs);
}

/**
 * Polite live-region copy for the results grid (issue #648).
 * Complements the partial/loading banners from iconPickerState (#847).
 */
export function iconPickerResultsStatus(opts: {
  surface: IconPickerSurfaceState;
  shownCount: number;
  totalMatchCount: number | null;
  truncated: boolean;
  query: string;
  categoryKey: string;
}): string {
  const q = opts.query.trim();
  const categoryLabel = iconPickerCategoryChipLabel(opts.categoryKey || 'all');

  if (opts.surface === 'loading') {
    if (opts.shownCount > 0) {
      const noun = opts.shownCount === 1 ? 'icon' : 'icons';
      return `${opts.shownCount} curated ${noun}. ${FULL_LIBRARY_SEARCHING_MESSAGE}`;
    }
    return FULL_LIBRARY_SEARCHING_MESSAGE;
  }

  if (opts.surface === 'partial') {
    if (opts.shownCount === 0) return '';
    const noun = opts.shownCount === 1 ? 'icon' : 'icons';
    const scope =
      opts.categoryKey && opts.categoryKey !== 'all'
        ? ` in ${categoryLabel}`
        : q
          ? ` for “${q}”`
          : '';
    return `${opts.shownCount} curated ${noun}${scope} — full library unavailable.`;
  }

  if (opts.surface === 'empty') {
    if (q && opts.categoryKey && opts.categoryKey !== 'all') {
      return `No icons match “${q}” in ${categoryLabel}.`;
    }
    if (q) return `No icons match “${q}”.`;
    if (opts.categoryKey && opts.categoryKey !== 'all') {
      return `No icons in ${categoryLabel}.`;
    }
    return 'No icons match your filters.';
  }

  const total = opts.totalMatchCount ?? opts.shownCount;
  const noun = opts.shownCount === 1 ? 'icon' : 'icons';
  const countPart =
    opts.truncated && total > opts.shownCount
      ? `Showing ${opts.shownCount} of ${total} ${total === 1 ? 'icon' : 'icons'}`
      : `${opts.shownCount} ${noun}`;

  const more = opts.truncated && total > opts.shownCount ? ' Refine your search to see more.' : '';

  if (q && opts.categoryKey && opts.categoryKey !== 'all') {
    return `${countPart} for “${q}” in ${categoryLabel}.${more}`;
  }
  if (q) return `${countPart} for “${q}”.${more}`;
  if (opts.categoryKey && opts.categoryKey !== 'all') {
    return `${countPart} in ${categoryLabel}.${more}`;
  }
  return `${countPart}.${more}`;
}

/** Roving tabindex target index for category chips (wraps). */
export function iconPickerNextCategoryKey(
  keys: readonly string[],
  currentKey: string,
  direction: 'next' | 'prev' | 'home' | 'end',
): string {
  const idx = keys.indexOf(currentKey);
  const safeIdx = idx >= 0 ? idx : 0;
  switch (direction) {
    case 'next':
      return keys[(safeIdx + 1) % keys.length] ?? keys[0]!;
    case 'prev':
      return keys[(safeIdx - 1 + keys.length) % keys.length] ?? keys[0]!;
    case 'home':
      return keys[0]!;
    case 'end':
      return keys[keys.length - 1]!;
  }
}
