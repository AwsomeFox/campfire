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
 * Split a (already-folded) string into the same alphanumeric tokens FTS5's
 * unicode61 tokenizer produces — mirroring {@link toFtsQuery}'s tokenization so
 * the LIKE/full-scan fallback can apply the SAME matching semantics as the FTS
 * index (issue #1481). Non-alphanumeric runs are separators, exactly as in the
 * FTS query builder and the `unicode61` tokenizer.
 */
const SEARCH_TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;
function searchTokens(folded: string): string[] {
  return folded.split(SEARCH_TOKEN_SEPARATOR).filter((t) => t.length > 0);
}

/**
 * FTS5-aligned prefix-token match (issue #1481). The fast path runs the query
 * through a real FTS5 index, whose `unicode61` tokenizer splits on
 * non-alphanumerics and whose `"token"*` syntax matches any token that STARTS
 * WITH the query token (a prefix match, not a substring match). The fallback
 * path used to use plain {@link foldedIncludes} (substring), so the SAME query
 * returned DIFFERENT results depending on whether the install had FTS5 — e.g.
 * "ex" matched "Vexley" only on the fallback. This helper restores parity: it
 * returns true only when EVERY query token is a prefix of some haystack token
 * (FTS5's implicit AND across tokens), so the fallback and the index agree for a
 * representative corpus. `haystack` is unfolded (display text); `foldedNeedle`
 * must already be folded, as elsewhere.
 *
 * Caveat: FTS5 is built with `remove_diacritics 2`, which strips Latin accents
 * from both index and query, whereas {@link foldForSearch} preserves them. The
 * two therefore still diverge for accent-stripping queries (e.g. "cafe" vs
 * "Café"); the reported defect was the prefix/substring split, which this fixes,
 * and a representative query corpus (ASCII names, dates, same-accent terms) is
 * identical across both modes.
 */
export function matchesSearchQuery(haystack: string, foldedNeedle: string): boolean {
  if (!foldedNeedle) return false;
  const needTokens = searchTokens(foldedNeedle);
  if (needTokens.length === 0) return false;
  const hayTokens = searchTokens(foldForSearch(haystack));
  if (hayTokens.length === 0) return false;
  return needTokens.every((nt) => hayTokens.some((ht) => ht.startsWith(nt)));
}

/**
 * Folded index of the first haystack token that STARTS WITH any query token
 * (issue #1481). {@link matchesSearchQuery} accepts non-contiguous multi-token
 * matches (e.g. "red dragon" inside "red ancient dragon"), but a snippet built
 * from a contiguous-substring index (`foldedIndexOf`) returns -1 for such a match
 * and would fall back to the field's opening, showing none of the matched terms.
 * This locates the first matched token so the snippet can be centered on it.
 * `haystack` is unfolded display text; `foldedNeedle` must already be folded.
 * Returns -1 when no query token prefix-matches any haystack token.
 */
export function firstTokenMatchIndex(haystack: string, foldedNeedle: string): number {
  if (!foldedNeedle) return -1;
  const need = searchTokens(foldedNeedle);
  if (need.length === 0) return -1;
  const folded = foldForSearch(haystack);
  // Walk each alphanumeric token at its REAL start offset. matchAll is position-
  // ordered and respects token boundaries, so a query token is never matched
  // inside an earlier, longer, non-matching word (a plain indexOf(token) would
  // return the first substring occurrence — e.g. "red" found inside "predators" —
  // and mis-center the snippet) (issue #1481).
  for (const match of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (need.some((nt) => match[0].startsWith(nt))) {
      return match.index ?? 0;
    }
  }
  return -1;
}

/**
 * The searchable form of a scheduled-session ISO timestamp (issue #1481). The
 * FTS5 index stores the date alongside a space-separated copy (T/:/- → space) so
 * date/time fragments like "19:30" or "2031-09-20" prefix-match as their own
 * tokens; in the raw ISO "19" is buried inside the single token "20T19" (T is
 * alphanumeric) and would never match. The full-scan fallback must match against
 * this SAME form, in BOTH the scheduling read and the result re-check, to agree
 * with the index.
 */
export function scheduledAtSearchText(scheduledAt: string): string {
  const spaced = scheduledAt.replace(/T/g, ' ').replace(/:/g, ' ').replace(/-/g, ' ');
  return `${scheduledAt} ${spaced}`;
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
