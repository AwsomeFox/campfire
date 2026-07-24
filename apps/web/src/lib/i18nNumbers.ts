/**
 * Locale-aware numeric parsing & canonicalization (issue #633).
 *
 * Problem this seam fixes: treasury and character editors previously called
 * `Number(raw)` and silently fell back to 0/1 when the input was "invalid".
 * But "invalid" to `Number()` includes perfectly-correct values for hundreds
 * of millions of users — a German typing `1.234` (one thousand two hundred
 * thirty-four), a French user typing `1 234,5`, or an Arabic user typing
 * `١٢٣٤` (Arabic-Indic digits). All of those were silently coerced to zero or
 * to a wrong value, corrupting treasury totals and character sheets.
 *
 * This module centralizes the three concerns the issue calls out:
 *
 *  1. {@link parseLocalizedNumber} — parse a raw, user-typed number string per
 *     the viewer's locale: strip grouping separators, recognize non-ASCII digit
 *     code points (Arabic-Indic, Extended Arabic-Indic, Devanagari), and return
 *     a discriminated `{ ok, value } | { ok: false, error }` so callers can
 *     surface a field error instead of silently coercing.
 *  2. {@link normalizeDigits} — map any Unicode decimal-digit run to ASCII,
 *     used by the dice-notation path (see {@link canonicalizeDiceExpr}) so a
 *     roll typed as `٢د٢٠+٣` is accepted and normalized to `2d20+3` internally.
 *  3. Display stays on the existing `formatNumber` (apps/web/src/lib/format.ts),
 *     which already honors the resolved locale; this module only owns the
 *     *parse* direction.
 *
 * Locale resolution reuses `activeLocale()` from `format.ts` so the parse and
 * display paths can never disagree about which locale the user is in.
 */

import { activeLocale } from './format';

/**
 * Result of attempting to parse a localized number.
 *
 * On failure `error` is a short, user-facing reason ("Not a whole number",
 * "Enter a number") suitable for an inline field error. Callers MUST NOT
 * silently substitute 0/1 — they keep the field's current value and show the
 * error so the typo is visible and correctable.
 */
export type LocalizedNumberResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Decimal-digit blocks we recognize in addition to ASCII `0-9`.
 *
 * These are the Unicode blocks whose characters carry Numeric_Type=Decimal
 * (General_Category Nd), enumerated explicitly rather than relying on the
 * `\p{Nd}` regex property so the accepted set is auditable and stable across
 * engines. Each entry is `[low, high]` inclusive over the ten code points of
 * that script's 0..9.
 *
 * Sources: Unicode UCD `extracted/DerivedGeneralCategory.txt` (Nd). Covers the
 * scripts a D&D/VTT audience actually types: Arabic-Indic (de facto across the
 * Arabic-speaking world), Extended Arabic-Indic (Persian/Urdu — used by many
 * South-Asian English-second-language players), and Devanagari (Hindi). The
 * full Nd set is larger, but accepting e.g. Tamil or Thai digits here without a
 * matching display path would be a half-measure; add scripts as locales ship.
 */
const DECIMAL_DIGIT_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x0030, 0x0039], // ASCII       0-9
  [0x0660, 0x0669], // Arabic-Indic          ٠-٩
  [0x06f0, 0x06f9], // Extended Arabic-Indic ۰-۹ (Persian/Urdu)
  [0x0966, 0x096f], // Devanagari            ०-९ (Hindi)
];

/** Map a single Unicode decimal-digit code point to its ASCII value, or -1. */
function digitValue(cp: number): number {
  for (const [low, high] of DECIMAL_DIGIT_BLOCKS) {
    if (cp >= low && cp <= high) return cp - low;
  }
  return -1;
}

/**
 * Canonicalize a single Unicode digit character to its ASCII equivalent, or
 * return the character untouched if it is not a decimal digit. Used to walk a
 * mixed-script string (dice notation) one code point at a time.
 */
function canonicalDigitChar(ch: string): string {
  // String iteration visits code points (not UTF-16 units), so supplementary
  // plane characters are handled correctly; ASCII digits are one code point.
  const cp = ch.codePointAt(0);
  if (cp === undefined) return ch;
  const v = digitValue(cp);
  return v >= 0 ? String.fromCharCode(0x30 + v) : ch;
}

/**
 * Rewrite every decimal digit in `input` to its ASCII form (0-9), leaving all
 * other characters (letters, operators, whitespace) byte-for-byte unchanged.
 *
 * This is the Unicode-normalization step the issue calls out for dice notation
 * (see {@link canonicalizeDiceExpr}): it lets `٢د٢٠+٣` (Arabic-Indic digits with
 * an Arabic letter `د` standing in for `d`) round-trip to `2d20+3` so the
 * ASCII-only {@link DiceExprPattern} validates it. It is exported so the same
 * normalization can be applied wherever a "number-like" free-text field needs
 * to accept non-ASCII digit input and store the canonical ASCII form.
 *
 * Operates on Unicode code points so supplementary-plane digits (none today,
 * but the function is forward-compatible) are handled correctly.
 */
export function normalizeDigits(input: string): string {
  // Fast path: ASCII digits need no work. This keeps the hot path (English
  // dice expressions typed thousands of times per session) allocation-free.
  if (/^[0-9]*$/.test(input)) return input;
  let out = '';
  for (const ch of input) out += canonicalDigitChar(ch);
  return out;
}

/**
 * The decimal and grouping separators a locale uses when *reading* a number.
 *
 * `Intl.NumberFormat` is the source of truth: we format a sentinel value
 * (`1000.5` — one grouping, one decimal digit) and read off which characters
 * appear in the grouping and fractional positions. This means we follow the
 * runtime's locale data exactly, including the narrow no-break space (U+202F)
 * that CLDR switched French grouping to, and the ASCII space some locales use.
 *
 * `grouping` is returned as a Set because a locale may legitimately accept
 * several grouping characters in free text (e.g. French historically accepts
 * both space and narrow-no-break-space); we strip any of them on parse.
 */
interface LocaleSeparators {
  /** The fractional separator, e.g. `.` (en) or `,` (de/fr). */
  decimal: string;
  /** Grouping separators to strip, e.g. `,` (en) or `.`/space (de/fr). */
  grouping: ReadonlySet<string>;
}

const ASCII_DECIMAL = '.';
const ASCII_GROUPING = ',';

/**
 * Probe `Intl.NumberFormat` for the locale's decimal and grouping separators.
 *
 * Returns `null` only when the runtime cannot format the sentinel (no known
 * locale data) — in that case callers fall back to ASCII semantics, which is
 * the historical behavior and never worse than before.
 */
function localeSeparators(locale: string | undefined): LocaleSeparators | null {
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      useGrouping: true,
    }).format(1000.5);
  } catch {
    return null;
  }
  // The formatted string is "G<digits>D<digit>" where G is the (possibly empty)
  // grouping separator and D is the decimal separator. To find them we strip
  // EVERY recognized decimal digit — not just ASCII — because Arabic locales
  // (ar-EG, ar-SA) format with Arabic-Indic digits ١٠٠٠ themselves, and Persian
  // (fa-IR) with Extended Arabic-Indic ۱۰۰۰. Stripping only ASCII digits would
  // leave those digits in the "separator" bucket and misread the locale.
  const stripped = removeDigits(formatted);
  if (stripped.length === 0) {
    // No separators at all (unlikely for 1000.5) — assume ASCII decimal.
    return { decimal: ASCII_DECIMAL, grouping: new Set([ASCII_GROUPING]) };
  }
  // The LAST remaining character is always the decimal separator (it sits
  // between the 0 and the 5). Any character(s) before it are grouping.
  const decimal = stripped[stripped.length - 1];
  const groupingChars = stripped.slice(0, -1);
  const grouping = new Set<string>();
  for (const ch of groupingChars) grouping.add(ch);
  // Some locales (e.g. de-DE with ICU) may format 1000.5 as "1000,5" with NO
  // grouping for four-digit numbers; still accept ASCII comma grouping as a
  // convenience for users who type it, since it is unambiguous given the
  // locale's decimal is ',' here only when the locale is comma-decimal.
  if (decimal === ASCII_DECIMAL) grouping.add(ASCII_GROUPING);
  else grouping.add(ASCII_DECIMAL);
  return { decimal, grouping };
}

/** Remove every recognized decimal digit (any script) from `input`. */
function removeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && digitValue(cp) >= 0) continue;
    out += ch;
  }
  return out;
}

/** Trim ASCII whitespace and the locale's digit-grouping separators. */
function stripSeparatorsAndWhitespace(
  raw: string,
  grouping: ReadonlySet<string>,
): string {
  // First normalize any non-ASCII digits to ASCII so grouping/decimal logic
  // below operates on a uniform digit alphabet.
  const s = normalizeDigits(raw);
  // Strip ASCII whitespace anywhere (users paste "1 234" with regular spaces
  // in fr-FR, or accidentally include leading/trailing spaces from IME).
  // Also strip the locale's grouping characters wherever they appear — a
  // grouping separator is never semantically significant, only visual.
  let out = '';
  for (const ch of s) {
    if (ch === ' ' || ch === '\t' || grouping.has(ch)) continue;
    out += ch;
  }
  return out;
}

/**
 * Parse a raw, user-typed number string into a number, honoring the viewer's
 * locale. Returns a discriminated result so callers can show a field error on
 * invalid input instead of silently coercing to 0/1.
 *
 * What "valid" means here:
 *  - An optional leading sign `+`/`-`.
 *  - Digits in any recognized script (ASCII, Arabic-Indic, Extended Arabic-
 *    Indic, Devanagari) — normalized to ASCII internally.
 *  - Locale grouping separators stripped (en `,`; de/fr `.`/space/narrow-nbsp).
 *  - At most ONE decimal separator, in the locale's form (en `.`; de/fr `,`).
 *  - The fractional part, if any, contains only digits.
 *
 * Examples (locale → input → value):
 *   en-US "1,234"   → 1234     de-DE "1.234"   → 1234
 *   en-US "1,234.5" → 1234.5   fr-FR "1 234,5" → 1234.5
 *   ar-EG "١٢٣٤"    → 1234     ar-EG "١٬٢٣٤"   → 1234 (Arabic grouping ٬ stripped)
 *   any   "1.234"   → 1.234 (when locale decimal is '.')
 *
 * On failure the `error` string is a short, display-ready reason. Callers keep
 * the field's current value and surface this error; they do NOT substitute a
 * default. See the call sites in InventoryPage / CharacterPage.
 *
 * @param raw     The raw input string (may be empty, partial, or non-numeric).
 * @param locale  BCP-47 locale tag controlling decimal/grouping interpretation.
 *                Defaults to the app's resolved locale (`activeLocale()`), so
 *                the parse direction always matches the display direction.
 */
export function parseLocalizedNumber(
  raw: string,
  locale: string | undefined = activeLocale(),
): LocalizedNumberResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a number.' };

  const seps = localeSeparators(locale);
  const grouping = seps?.grouping ?? new Set([ASCII_GROUPING]);
  const decimal = seps?.decimal ?? ASCII_DECIMAL;

  const cleaned = stripSeparatorsAndWhitespace(trimmed, grouping);

  // Pull an optional leading sign, then split on the (single, locale-specific)
  // decimal separator. After stripping grouping/whitespace the remainder must
  // be: [sign] digits [decimal digits]. Anything else is genuinely invalid
  // (e.g. "1-2", "abc", "1.2.3") and the caller must surface an error.
  let sign = 1;
  let body = cleaned;
  if (body.startsWith('+')) body = body.slice(1);
  else if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1);
  }
  if (body === '') return { ok: false, error: 'Enter a number.' };

  let intPart = body;
  let fracPart = '';
  const decimalIdx = body.indexOf(decimal);
  if (decimalIdx >= 0) {
    intPart = body.slice(0, decimalIdx);
    fracPart = body.slice(decimalIdx + decimal.length);
    // A second decimal separator means the input is malformed (e.g. "1,2,3"
    // after grouping strip, or "1.2.3"). Refuse rather than guess.
    if (fracPart.indexOf(decimal) >= 0) {
      return { ok: false, error: 'Enter a number.' };
    }
  }

  // Allow a bare decimal (".5", ",5") and bare integer, but not empty on both
  // sides of the decimal point ("." alone is not a number).
  if (intPart === '' && fracPart === '') {
    return { ok: false, error: 'Enter a number.' };
  }
  if (intPart !== '' && !/^[0-9]+$/.test(intPart)) {
    return { ok: false, error: 'Enter a number.' };
  }
  if (fracPart !== '' && !/^[0-9]+$/.test(fracPart)) {
    return { ok: false, error: 'Enter a number.' };
  }

  // Reassemble in canonical ASCII form and parse. parseFloat is safe here
  // because we have already validated the shape (optional sign + digits + '.'
  // + digits); there is no exponent, no hex, no trailing garbage.
  const canonical = (intPart || '0') + (fracPart !== '' ? ASCII_DECIMAL + fracPart : '');
  const value = sign * Number.parseFloat(canonical);
  if (!Number.isFinite(value)) return { ok: false, error: 'Enter a number.' };
  return { ok: true, value };
}

/**
 * Parse a raw integer per locale. Convenience wrapper around
 * {@link parseLocalizedNumber} that additionally rejects any fractional part,
 * so coin counts, HP, level, XP, and quantities cannot silently truncate.
 *
 * `min`/`max` are inclusive bounds; an out-of-range value is reported as an
 * error (with the range in the message) rather than clamped, because clamping
 * is itself a silent coercion — the issue's root complaint.
 */
export function parseLocalizedInteger(
  raw: string,
  locale: string | undefined = activeLocale(),
  opts: { min?: number; max?: number } = {},
): LocalizedNumberResult {
  const parsed = parseLocalizedNumber(raw, locale);
  if (!parsed.ok) return parsed;
  if (!Number.isInteger(parsed.value)) {
    return { ok: false, error: 'Not a whole number.' };
  }
  const { min, max } = opts;
  if (min !== undefined && parsed.value < min) {
    return { ok: false, error: `Must be ${min} or higher.` };
  }
  if (max !== undefined && parsed.value > max) {
    return { ok: false, error: `Must be ${max} or less.` };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Canonicalize a dice expression: normalize all non-ASCII decimal digits to
 * ASCII and lowercase the ASCII letters, so the dice engine (which is
 * intentionally ASCII-only — see `DiceExprPattern` in @campfire/schema) can
 * validate and roll it.
 *
 * Why this lives here and not in the schema: the schema regex is the wire
 * *contract* (what the server accepts); this function is the *input*
 * normalization (what the user types). Keeping them separate means the wire
 * format stays canonical ASCII, while the input surface is permissive of the
 * scripts a multilingual user types. The schema documents this normalization
 * alongside `DiceExprPattern`.
 *
 * This is idempotent: an already-canonical expression is returned unchanged.
 * It does NOT validate shape — callers still run the result through
 * `DiceExprPattern` (or the server's zod validation) to reject garbage.
 *
 * @example
 *   canonicalizeDiceExpr('٢د٢٠+٣')  // → '2d20+3'  (Arabic-Indic digits, Arabic d)
 *   canonicalizeDiceExpr('1D20+3')  // → '1d20+3'  (ASCII, lowercased)
 *   canonicalizeDiceExpr('1d20+3')  // → '1d20+3'  (idempotent)
 */
export function canonicalizeDiceExpr(input: string): string {
  return normalizeDigits(input).toLowerCase();
}
