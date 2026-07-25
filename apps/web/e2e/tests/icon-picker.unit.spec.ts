import { expect, test } from '@playwright/test';
import {
  FULL_LIBRARY_FAILED_MESSAGE,
  FULL_LIBRARY_LOADING_MESSAGE,
  FULL_LIBRARY_PARTIAL_EMPTY_MESSAGE,
  FULL_LIBRARY_SEARCHING_MESSAGE,
  fullLibraryStatus,
  iconPickerGridEmptyMessage,
  iconPickerSurfaceState,
  noIconsMatchMessage,
  showFullLibraryLoadingBanner,
  showPartialLibraryBanner,
} from '../../src/components/iconPickerState';
import {
  ICON_PICKER_AUTO_LABEL,
  ICON_PICKER_CATEGORY_FILTER_LABEL,
  ICON_PICKER_CLEAR_LABEL,
  ICON_PICKER_CURRENT_LABEL,
  ICON_PICKER_RECENT_STORAGE_KEY,
  ICON_PICKER_REPLACE_LABEL,
  ICON_PICKER_RESULT_LIMIT,
  countFullIconIndexMatches,
  iconPickerCategoryChipLabel,
  iconPickerCategoryKeys,
  iconPickerCategoryValue,
  iconPickerGridResults,
  iconPickerNextCategoryKey,
  iconPickerPinnedIsAuto,
  iconPickerPinnedSlug,
  iconPickerResultsStatus,
  iconPickerSuggestionSlugs,
  iconPickerTotalMatchCount,
  readRecentIconPickerSlugs,
  recordRecentIconPickerSlug,
  shouldShowIconPickerAutoAction,
  shouldShowIconPickerClearAction,
  shouldShowIconPickerNoneTile,
} from '../../src/components/iconPickerA11y';

/**
 * Issue #847 — IconPicker must disclose curated-only / still-loading modes and
 * offer a visible Retry that does not clear the search query.
 *
 * Surface classification (loading / partial / empty / complete) lives in
 * `iconPickerState.ts` so it can be pinned here without mounting the dialog.
 * The component's only job is to render that surface, keep `query` in its own
 * state (Retry bumps `loadAttempt` only), and wire ErrorNote's accessible alert.
 */

const READY_INDEX = [
  { slug: 'sword', category: 'weapons', name: 'Sword', artist: 'lorc', shard: 0 },
  { slug: 'axe', category: 'weapons', name: 'Axe', artist: 'lorc', shard: 0 },
] as const;

test.describe('icon picker surface states (issue #847)', () => {
  test('loading: full index still in flight, with or without curated matches', () => {
    expect(fullLibraryStatus(undefined)).toBe('loading');
    expect(iconPickerSurfaceState(undefined, 0)).toBe('loading');
    expect(iconPickerSurfaceState(undefined, 12)).toBe('loading');
    expect(showFullLibraryLoadingBanner(undefined)).toBe(true);
    expect(showPartialLibraryBanner(undefined)).toBe(false);
    expect(FULL_LIBRARY_LOADING_MESSAGE).toMatch(/loading/i);
    expect(FULL_LIBRARY_SEARCHING_MESSAGE).toMatch(/searching/i);
    expect(iconPickerGridEmptyMessage('loading', 'sword')).toBe(FULL_LIBRARY_SEARCHING_MESSAGE);
  });

  test('partial: full index failed — disclose curated-only mode even when tiles match', () => {
    expect(fullLibraryStatus(null)).toBe('failed');
    // Curated hits must not look like a complete catalog answer.
    expect(iconPickerSurfaceState(null, 8)).toBe('partial');
    // Zero curated hits still count as partial so failure isn't mistaken for
    // a definitive empty catalog (impact: inventory/treasury/compendium search).
    expect(iconPickerSurfaceState(null, 0)).toBe('partial');
    expect(showPartialLibraryBanner(null)).toBe(true);
    expect(showFullLibraryLoadingBanner(null)).toBe(false);
    expect(FULL_LIBRARY_FAILED_MESSAGE).toMatch(/curated/i);
    expect(FULL_LIBRARY_FAILED_MESSAGE).toMatch(/couldn't load|couldn’t load/i);
    // Zero curated matches must show failure/Retry empty copy — never a
    // definitive "No icons match …" while the full library is unavailable.
    expect(iconPickerGridEmptyMessage('partial', 'treasury')).toBe(
      FULL_LIBRARY_PARTIAL_EMPTY_MESSAGE,
    );
    expect(iconPickerGridEmptyMessage('partial', 'treasury')).toMatch(/retry/i);
    expect(iconPickerGridEmptyMessage('partial', 'treasury')).not.toMatch(/no icons match/i);
    expect(iconPickerGridEmptyMessage('partial', 'treasury')).not.toBe(
      noIconsMatchMessage('treasury'),
    );
  });

  test('empty: full index ready and the query matched nothing', () => {
    expect(fullLibraryStatus(READY_INDEX)).toBe('ready');
    expect(iconPickerSurfaceState(READY_INDEX, 0)).toBe('empty');
    expect(showPartialLibraryBanner(READY_INDEX)).toBe(false);
    expect(showFullLibraryLoadingBanner(READY_INDEX)).toBe(false);
    expect(noIconsMatchMessage('dragon')).toContain('dragon');
    expect(noIconsMatchMessage('dragon')).toMatch(/no icons match/i);
    expect(iconPickerGridEmptyMessage('empty', 'dragon')).toBe(noIconsMatchMessage('dragon'));
  });

  test('complete: full index ready with at least one match', () => {
    expect(iconPickerSurfaceState(READY_INDEX, 1)).toBe('complete');
    expect(iconPickerSurfaceState(READY_INDEX, 40)).toBe('complete');
    expect(showPartialLibraryBanner(READY_INDEX)).toBe(false);
    expect(showFullLibraryLoadingBanner(READY_INDEX)).toBe(false);
    expect(iconPickerGridEmptyMessage('complete', 'sword')).toBeNull();
  });

  test('curated results remain available offline (partial still reports match counts)', () => {
    // Offline/uncached full-index failure must keep curated matches selectable;
    // the surface stays `partial` rather than collapsing to empty/complete.
    const curatedMatchCount = 5;
    expect(iconPickerSurfaceState(null, curatedMatchCount)).toBe('partial');
    expect(showPartialLibraryBanner(null)).toBe(true);
  });

  test('Retry affordance copy is distinct from the loading status (query stays in component state)', () => {
    // Component keeps `query` in useState and only bumps `loadAttempt` on Retry,
    // so the search string is preserved across a failed → loading → ready cycle.
    // These copy pins ensure the failure path asks for Retry while loading does not.
    expect(FULL_LIBRARY_FAILED_MESSAGE).not.toEqual(FULL_LIBRARY_LOADING_MESSAGE);
    expect(showPartialLibraryBanner(null)).toBe(true);
    // After Retry the effect resets to undefined → loading banner, not a second alert.
    expect(showPartialLibraryBanner(undefined)).toBe(false);
    expect(showFullLibraryLoadingBanner(undefined)).toBe(true);
  });
});

test.describe('icon picker UX helpers (issue #648)', () => {
  test('category filter uses named radiogroup vocabulary', () => {
    expect(ICON_PICKER_CATEGORY_FILTER_LABEL).toMatch(/category/i);
    expect(iconPickerCategoryKeys(['weapons', 'armor'])).toEqual(['all', 'weapons', 'armor']);
    expect(iconPickerCategoryValue('all')).toBe('');
    expect(iconPickerCategoryValue('weapons')).toBe('weapons');
    expect(iconPickerCategoryChipLabel('arcane-focus')).toBe('Arcane Focus');
  });

  test('roving category keys wrap at the ends', () => {
    const keys = ['all', 'weapons', 'armor'];
    expect(iconPickerNextCategoryKey(keys, 'all', 'prev')).toBe('armor');
    expect(iconPickerNextCategoryKey(keys, 'armor', 'next')).toBe('all');
    expect(iconPickerNextCategoryKey(keys, 'weapons', 'home')).toBe('all');
    expect(iconPickerNextCategoryKey(keys, 'weapons', 'end')).toBe('armor');
    expect(iconPickerNextCategoryKey([], 'weapons', 'next')).toBe('weapons');
  });

  test('pins explicit value and auto slug; dedupes grid', () => {
    expect(iconPickerPinnedSlug('sword', 'axe')).toBe('sword');
    expect(iconPickerPinnedSlug('', 'axe')).toBe('axe');
    expect(iconPickerPinnedSlug('', '')).toBeNull();
    expect(iconPickerPinnedIsAuto('', 'axe')).toBe(true);
    expect(iconPickerPinnedIsAuto('sword', 'axe')).toBe(false);

    const results = [{ slug: 'sword' }, { slug: 'axe' }];
    expect(iconPickerGridResults(results, 'sword')).toEqual([{ slug: 'axe' }]);
    expect(iconPickerGridResults(results, null)).toEqual(results);
  });

  test('Replace/Auto/Clear affordances follow inventory vs entity rules', () => {
    expect(ICON_PICKER_REPLACE_LABEL).toBe('Replace');
    expect(ICON_PICKER_AUTO_LABEL).toBe('Auto');
    expect(ICON_PICKER_CLEAR_LABEL).toBe('Clear');
    expect(ICON_PICKER_CURRENT_LABEL).toMatch(/current/i);

    expect(shouldShowIconPickerAutoAction('sword', 'axe')).toBe(true);
    expect(shouldShowIconPickerAutoAction('', 'axe')).toBe(false);
    expect(shouldShowIconPickerClearAction('sword', undefined)).toBe(true);
    expect(shouldShowIconPickerClearAction('sword', 'axe')).toBe(false);
    expect(shouldShowIconPickerNoneTile(undefined)).toBe(true);
    expect(shouldShowIconPickerNoneTile('axe')).toBe(false);
  });

  test('announces result counts, truncation, and offline curated-only scope', () => {
    expect(
      iconPickerResultsStatus({
        surface: 'complete',
        shownCount: ICON_PICKER_RESULT_LIMIT,
        totalMatchCount: 412,
        truncated: true,
        query: '',
        categoryKey: 'all',
      }),
    ).toMatch(/showing 240 of 412/i);

    expect(
      iconPickerResultsStatus({
        surface: 'complete',
        shownCount: 3,
        totalMatchCount: 3,
        truncated: false,
        query: 'sword',
        categoryKey: 'weapons',
      }),
    ).toBe('3 icons for “sword” in Weapons.');

    expect(
      iconPickerResultsStatus({
        surface: 'partial',
        shownCount: 4,
        totalMatchCount: 4,
        truncated: false,
        query: 'potion',
        categoryKey: 'all',
      }),
    ).toMatch(/curated icons/i);
    expect(
      iconPickerResultsStatus({
        surface: 'partial',
        shownCount: 4,
        totalMatchCount: 4,
        truncated: false,
        query: 'potion',
        categoryKey: 'all',
      }),
    ).toMatch(/full library unavailable/i);

    expect(
      iconPickerResultsStatus({
        surface: 'loading',
        shownCount: 0,
        totalMatchCount: null,
        truncated: false,
        query: '',
        categoryKey: 'all',
      }),
    ).toBe(FULL_LIBRARY_SEARCHING_MESSAGE);
  });

  test('total match count dedupes curated slugs from the full index', () => {
    const curatedSlugs = new Set(['sword']);
    expect(countFullIconIndexMatches(READY_INDEX, '', '', curatedSlugs)).toBe(1);
    expect(
      iconPickerTotalMatchCount({
        curatedCount: 1,
        curatedSlugs,
        fullIndex: READY_INDEX,
        query: '',
        category: '',
      }),
    ).toBe(2);
    expect(
      iconPickerTotalMatchCount({
        curatedCount: 1,
        curatedSlugs,
        fullIndex: undefined,
        query: '',
        category: '',
      }),
    ).toBeNull();
    expect(
      iconPickerTotalMatchCount({
        curatedCount: 2,
        curatedSlugs,
        fullIndex: null,
        query: '',
        category: '',
      }),
    ).toBe(2);
  });

  test('recent and contextual suggestions merge without duplicates', () => {
    const storage = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    recordRecentIconPickerSlug('sword', mockStorage);
    recordRecentIconPickerSlug('axe', mockStorage);
    recordRecentIconPickerSlug('sword', mockStorage);
    expect(readRecentIconPickerSlugs(mockStorage)).toEqual(['sword', 'axe']);
    expect(storage.get(ICON_PICKER_RECENT_STORAGE_KEY)).toBeTruthy();

    expect(iconPickerSuggestionSlugs(['axe', 'bow'], ['sword', 'axe'])).toEqual([
      'sword',
      'axe',
      'bow',
    ]);
  });
});
