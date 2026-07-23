/**
 * Pure surface-state helpers for IconPicker (issue #847).
 *
 * The bug this fixes: when the full ~4,130-icon library is still loading or
 * fails, curated matches can still render — and the picker used to look like a
 * complete catalog answer. Failure was buried in a tiny footer, so authors
 * searching for inventory/treasury/compendium art couldn't tell "no such icon"
 * from "the larger library did not load."
 *
 * Kept free of React/DOM so loading / partial / empty / complete are pinned in
 * a `.unit.spec.ts` without a browser. The component owns the side effects:
 * calling `loadFullIconIndex`, retrying on demand, and rendering the snapshot.
 */

/** How far the lazy full-set index load has progressed. */
export type FullLibraryStatus = 'loading' | 'failed' | 'ready';

/**
 * User-visible results surface for the picker.
 *
 * - loading  — full index still in flight (curated tiles may already show)
 * - partial  — full index failed; curated-only mode (always disclose + Retry)
 * - empty    — full index ready and the query matched nothing
 * - complete — full index ready and at least one match is shown
 *
 * Partial wins over empty when the load failed: a zero-match curated search
 * must not read as a definitive "no such icon" while the larger library is
 * unavailable.
 */
export type IconPickerSurfaceState = 'loading' | 'partial' | 'empty' | 'complete';

/** Polite status while the full index chunk is still resolving. */
export const FULL_LIBRARY_LOADING_MESSAGE = 'Loading the full icon library…';

/** Grid placeholder when there are zero curated hits and the index is still loading. */
export const FULL_LIBRARY_SEARCHING_MESSAGE = 'Searching the full icon library…';

/**
 * Visible failure copy for curated-only mode. Paired with a Retry action; kept
 * short so it stays unobtrusive next to an otherwise usable result grid.
 */
export const FULL_LIBRARY_FAILED_MESSAGE =
  "Couldn't load the full icon library — showing curated icons only.";

/** Empty-query copy once the full library is ready (trustworthy "no such icon"). */
export function noIconsMatchMessage(query: string): string {
  return `No icons match “${query}”.`;
}

export function fullLibraryStatus(
  fullIndex: readonly unknown[] | null | undefined,
): FullLibraryStatus {
  if (fullIndex === undefined) return 'loading';
  if (fullIndex === null) return 'failed';
  return 'ready';
}

/**
 * Classify the picker's visible surface from the lazy-index slot and match count.
 *
 * `fullIndex` uses the same sentinel the component stores:
 *   undefined → still loading, null → failed, array → ready.
 */
export function iconPickerSurfaceState(
  fullIndex: readonly unknown[] | null | undefined,
  matchCount: number,
): IconPickerSurfaceState {
  const lib = fullLibraryStatus(fullIndex);
  if (lib === 'loading') return 'loading';
  if (lib === 'failed') return 'partial';
  return matchCount > 0 ? 'complete' : 'empty';
}

/** Whether the partial-results banner (failure + Retry) should render. */
export function showPartialLibraryBanner(
  fullIndex: readonly unknown[] | null | undefined,
): boolean {
  return fullLibraryStatus(fullIndex) === 'failed';
}

/** Whether the unobtrusive "still loading full library" status should render. */
export function showFullLibraryLoadingBanner(
  fullIndex: readonly unknown[] | null | undefined,
): boolean {
  return fullLibraryStatus(fullIndex) === 'loading';
}
