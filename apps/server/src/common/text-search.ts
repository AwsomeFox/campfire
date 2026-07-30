/**
 * Shared free-text search normalization (issue #624).
 *
 * Campaign search, note `q` filters, and related helpers must fold needle and
 * haystack the same way so Unicode matches do not depend on the host locale or
 * on SQLite's ASCII-only `lower()`.
 *
 * Pipeline (deterministic, locale-fixed):
 *  1. NFKC — compatibility normalize (ligatures, composed vs decomposed accents)
 *  2. `toLocaleLowerCase('en-US')` — never the runtime default locale
 *  3. Pragmatic search-fold extras aligned with Unicode full case folding:
 *     - en-US maps capital İ (U+0130) to "i" + combining dot; collapse to "i"
 *       so ASCII needles match Turkish titles
 *     - ß → ss so "strasse" matches "Straße"
 *
 * Display text must stay untouched — fold only for comparison / ranking keys.
 */

/** Fixed locale for case folding — do not substitute the runtime default. */
export const SEARCH_FOLD_LOCALE = 'en-US';

/**
 * Deterministic fold for substring search. Apply to both needle and haystack
 * before `includes` / `indexOf`.
 */
export function foldForSearch(input: string): string {
  return input
    .normalize('NFD')
    // Target combining diacritical marks only, preserving non-Latin marks (e.g. Japanese voiced/semi-voiced kana U+3099/U+309A)
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u{0300}-\u{036f}\u{1ab0}-\u{1aff}\u{1dc0}-\u{1dff}\u{20d0}-\u{20ff}\u{fe20}-\u{fe2f}]/gu, '')
    .normalize('NFKC')
    .toLocaleLowerCase(SEARCH_FOLD_LOCALE)
    // İ → "i" + COMBINING DOT ABOVE under en-US; plain "i" for ASCII parity.
    .replace(/\u0069\u0307/g, 'i')
    // Unicode full case folding maps ß → ss, æ → ae, œ → oe.
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe');
}

/** True when `haystack` contains `foldedNeedle` (needle must already be folded). */
export function foldedIncludes(haystack: string, foldedNeedle: string): boolean {
  if (!foldedNeedle) return true;
  return foldForSearch(haystack).includes(foldedNeedle);
}

/**
 * Index of `foldedNeedle` inside the folded haystack, or -1.
 * Useful for snippet windows; when NFKC changes length the index is approximate
 * relative to the original string — callers must still slice the original text.
 */
export function foldedIndexOf(haystack: string, foldedNeedle: string): number {
  if (!foldedNeedle) return 0;
  return foldForSearch(haystack).indexOf(foldedNeedle);
}

/**
 * Deterministic string compare for search result ordering.
 * Explicit `en` locales — never `localeCompare` with no locales (runtime default).
 */
export function compareSearchText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'variant', numeric: true });
}
