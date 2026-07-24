/**
 * Grapheme-aware avatar/initials helpers (issue #631).
 *
 * Earlier surfaces (`avatar.ts`, `Layout`, `NpcPage`, `MembersPage`, `InboxPage`, …)
 * sliced code units: `"🐶".slice(0, 1)` and `"A🇸🇪".slice(0, 1)` returned half of a
 * surrogate pair / regional-indicator pair, which rendered as the replacement glyph
 * (tofu). Combined marks (é as `e` + `\u0301`) and ZWJ emoji (family/skin-tone
 * sequences) were likewise split mid-cluster.
 *
 * This module routes every name → initials/avatar-letter conversion through
 * `Intl.Segmenter` (granularity: `grapheme`) when available, with a Unicode-aware
 * fallback that groups combining marks and keeps regional-indicator / ZWJ emoji
 * intact on runtimes without `Segmenter`. Casing is locale-aware via
 * `String.prototype.toLocaleUpperCase` so Turkish dotted/dotless-i, etc. behave.
 */

type GraphemeSegment = { segment: string };
type GraphemeSegmenterLike = { segment(input: string): Iterable<GraphemeSegment> };
type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenterLike;

type SegmenterProvider = () => GraphemeSegmenterLike | null;

// Test hook: a non-null value replaces the native lookup so the fallback path can
// be exercised in environments that DO ship Intl.Segmenter.
let segmenterProviderOverride: SegmenterProvider | null = null;

/** Cached native Segmenter — construction is relatively expensive on hot render paths. */
let cachedNativeSegmenter: GraphemeSegmenterLike | null | undefined;

/** @internal Visible for tests. Force the fallback (or restore native). */
export function setGraphemeSegmenterProviderForTest(provider: SegmenterProvider | null): void {
  segmenterProviderOverride = provider;
}

function nativeSegmenter(): GraphemeSegmenterLike | null {
  if (segmenterProviderOverride) return segmenterProviderOverride();
  if (cachedNativeSegmenter !== undefined) return cachedNativeSegmenter;

  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (!Segmenter) {
    cachedNativeSegmenter = null;
    return null;
  }
  // `und` (undefined language) gives script-default grapheme clustering independent
  // of the viewer's locale — grapheme boundaries are not locale-dependent for the
  // clusters we care about (emoji, combining marks, regional indicators, ZWJ).
  try {
    cachedNativeSegmenter = new Segmenter('und', { granularity: 'grapheme' });
  } catch {
    cachedNativeSegmenter = null;
  }
  return cachedNativeSegmenter;
}

/**
 * Build a RegExp via constructor so engines that reject `\u{…}` / `\p{…}` fail at
 * runtime (caught) instead of preventing the module from parsing at load time.
 */
function tryRegExp(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

// Prefer Unicode-escape / property-escape forms when the engine supports them;
// otherwise fall back to numeric code-point checks (see helpers below).
// Anchored so an already-joined flag pair never matches as "a regional indicator".
const REGIONAL_INDICATOR_RE = tryRegExp('^[\\u{1F1E6}-\\u{1F1FF}]$', 'u');
const COMBINING_MARK_RE = tryRegExp('^\\p{M}$', 'u');
const FITZPATRICK_RE = tryRegExp('^[\\u{1F3FB}-\\u{1F3FF}]$', 'u');
// ZWJ is in the BMP — plain escapes parse everywhere.
const ZWJ = /^\u200D$/;
const TRAILING_ZWJ = /\u200D$/;

function singleCodePoint(value: string): number | null {
  if (!value) return null;
  const cp = value.codePointAt(0);
  if (cp === undefined) return null;
  // Reject multi-code-point clusters (e.g. an already-formed flag pair).
  return cp > 0xffff ? (value.length === 2 ? cp : null) : value.length === 1 ? cp : null;
}

/** True iff `value` is exactly one regional-indicator code point (not a flag pair). */
function isSingleRegionalIndicator(value: string): boolean {
  if (REGIONAL_INDICATOR_RE) return REGIONAL_INDICATOR_RE.test(value);
  const cp = singleCodePoint(value);
  return cp !== null && cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function isCombiningMark(value: string): boolean {
  if (COMBINING_MARK_RE) return COMBINING_MARK_RE.test(value);
  const cp = singleCodePoint(value);
  if (cp === null) return false;
  // Common combining-mark blocks used by avatar/name text when `\p{M}` is unavailable.
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe20 && cp <= 0xfe2f) // Combining Half Marks
  );
}

function isFitzpatrick(value: string): boolean {
  if (FITZPATRICK_RE) return FITZPATRICK_RE.test(value);
  const cp = singleCodePoint(value);
  return cp !== null && cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/**
 * Conservative grapheme fallback used when `Intl.Segmenter` is unavailable.
 *
 * It groups combining marks onto the preceding base, keeps regional-indicator
 * pairs together, attaches Fitzpatrick skin-tone modifiers, and extends ZWJ
 * emoji sequences. It is intentionally not a full UAX #29 implementation: it
 * covers the clusters called out in the issue (emoji, flags, skin tones, ZWJ,
 * combining marks) while staying small and dependency-free.
 */
function fallbackGraphemes(input: string): string[] {
  const result: string[] = [];
  for (const codePoint of input) {
    const previous = result[result.length - 1];
    if (previous !== undefined) {
      // Extend a lone regional indicator into a flag (exactly two indicators).
      // After a complete flag, the next indicator must start a new cluster so
      // consecutive flags like 🇺🇸🇨🇦 do not merge into one grapheme.
      if (isSingleRegionalIndicator(previous) && isSingleRegionalIndicator(codePoint)) {
        result[result.length - 1] = previous + codePoint;
        continue;
      }
      // Attach combining marks and Fitzpatrick skin-tone modifiers to the base.
      if (isCombiningMark(codePoint) || isFitzpatrick(codePoint)) {
        result[result.length - 1] = previous + codePoint;
        continue;
      }
      // A ZWJ always joins to the running cluster…
      if (ZWJ.test(codePoint)) {
        result[result.length - 1] = previous + codePoint;
        continue;
      }
      // …and if the cluster ENDS with a ZWJ, this code point is the joined half
      // of the same emoji (e.g. the woman in `man ZWJ woman`). The TRAILING_ZWJ
      // anchor is critical: testing for a ZWJ anywhere in `previous` would glue
      // every later character (spaces, Latin letters) onto the emoji forever.
      if (TRAILING_ZWJ.test(previous)) {
        result[result.length - 1] = previous + codePoint;
        continue;
      }
    }
    result.push(codePoint);
  }
  return result;
}

/**
 * Split `input` into user-perceived characters (grapheme clusters).
 *
 * Prefers `Intl.Segmenter`; falls back to {@link fallbackGraphemes} when the
 * runtime lacks it (older embedded browsers / the test override).
 */
export function graphemes(input: string): string[] {
  const segmenter = nativeSegmenter();
  if (segmenter) {
    const out: string[] = [];
    for (const { segment } of segmenter.segment(input)) out.push(segment);
    return out;
  }
  return fallbackGraphemes(input);
}

/**
 * Locale-aware uppercasing for avatar display.
 *
 * `String.prototype.toUpperCase()` is locale-independent (ASCII-style) and would
 * map Turkish `i` → `I` rather than `İ`. We delegate to `toLocaleUpperCase` with
 * an explicit locale when one is supplied, mirroring the rest of the i18n seam.
 */
function toUpperCluster(cluster: string, locale?: string): string {
  try {
    return locale ? cluster.toLocaleUpperCase(locale) : cluster.toUpperCase();
  } catch {
    return cluster.toUpperCase();
  }
}

/**
 * Build initials for a display name, grapheme-aware.
 *
 * - Empty / whitespace-only → `'?'`.
 * - Single token → the first two graphemes of that token (e.g. `"Aš"` ← `"Ašar"`).
 * - Multiple tokens → the first grapheme of the first and last tokens.
 *
 * The result is uppercased for avatar display via {@link toUpperCluster}. Pass a
 * `locale` to opt into locale-aware casing (Turkish, Lithuanian, etc.); omit it
 * for locale-independent ASCII casing (the pre-fix behaviour).
 *
 * Examples:
 *   initials('Ada Lovelace')        === 'AL'
 *   initials('Ashen cultist')       === 'AC'
 *   initials('Goblin 1')            === 'G1'
 *   initials('🐶 Dogbert')          === '🐶D'
 *   initials('攀 登者')             === '攀登'
 *   initials('مدیر فروش')           === 'مر'  (RTL — first/last by logical order)
 *   initials('Ada')                 === 'AD'
 *   initials('')                    === '?'
 */
export function initials(name: string, locale?: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '?';
  if (tokens.length === 1) {
    const firstTwo = graphemes(tokens[0]!).slice(0, 2);
    return toUpperCluster(firstTwo.join(''), locale);
  }
  const firstGrapheme = graphemes(tokens[0]!)[0] ?? '';
  const lastGrapheme = graphemes(tokens[tokens.length - 1]!)[0] ?? '';
  return toUpperCluster(firstGrapheme + lastGrapheme, locale);
}

/**
 * First grapheme of a display name — for the single-letter avatar circles used
 * in MembersPage / InboxPage. Empty / whitespace-only → `'?'`. Uppercased via
 * {@link toUpperCluster} when a locale is supplied.
 *
 * Examples:
 *   firstGrapheme('🐶 Dogbert') === '🐶'
 *   firstGrapheme('éowyn')      === 'É'
 *   firstGrapheme('')           === '?'
 */
export function firstGrapheme(name: string, locale?: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const [head] = graphemes(trimmed);
  return toUpperCluster(head ?? '?', locale);
}
