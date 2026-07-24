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

/**
 * Issue #847 — IconPicker must disclose curated-only / still-loading modes and
 * offer a visible Retry that does not clear the search query.
 *
 * Surface classification (loading / partial / empty / complete) lives in
 * `iconPickerState.ts` so it can be pinned here without mounting the dialog.
 * The component's only job is to render that surface, keep `query` in its own
 * state (Retry bumps `loadAttempt` only), and wire ErrorNote's accessible alert.
 */

const READY_INDEX: readonly { slug: string }[] = [{ slug: 'sword' }];

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
