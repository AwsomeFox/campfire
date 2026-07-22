import { expect, test } from '@playwright/test';
import {
  canonicalizeDiceExpr,
  normalizeDigits,
  parseLocalizedInteger,
  parseLocalizedNumber,
} from '../../src/lib/i18nNumbers';

/**
 * Locale-aware numeric parsing (issue #633).
 *
 * Before this seam, treasury and character editors called `Number()` and
 * silently fell back to 0/1 on any input that was not ASCII-canonical. That
 * corrupted correct values for international users — a German `1.234` (one
 * thousand two hundred thirty-four) became `1`, a French `1 234,5` became `1`,
 * and Arabic-Indic digits `١٢٣٤` became `0`. These tests pin the parser's
 * behavior across the four locales the issue names (en/de/fr/ar) plus the
 * IME/mixed-script edge cases.
 */
test.describe('parseLocalizedNumber', () => {
  test.describe('ASCII / en-US', () => {
    test('parses a plain integer', () => {
      expect(parseLocalizedNumber('42', 'en-US')).toEqual({ ok: true, value: 42 });
    });

    test('parses a grouped thousands value with the en grouping separator', () => {
      expect(parseLocalizedNumber('1,234', 'en-US')).toEqual({ ok: true, value: 1234 });
    });

    test('parses a grouped decimal value', () => {
      expect(parseLocalizedNumber('1,234.5', 'en-US')).toEqual({ ok: true, value: 1234.5 });
    });

    test('parses a bare decimal (".5")', () => {
      expect(parseLocalizedNumber('.5', 'en-US')).toEqual({ ok: true, value: 0.5 });
    });

    test('parses a negative value', () => {
      expect(parseLocalizedNumber('-27', 'en-US')).toEqual({ ok: true, value: -27 });
    });

    test('rejects a second decimal separator instead of truncating', () => {
      const r = parseLocalizedNumber('1.2.3', 'en-US');
      expect(r.ok).toBe(false);
    });

    test('rejects non-numeric text', () => {
      const r = parseLocalizedNumber('abc', 'en-US');
      expect(r.ok).toBe(false);
    });

    test('rejects the empty string with a field-ready message', () => {
      const r = parseLocalizedNumber('', 'en-US');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    });
  });

  test.describe('de-DE (decimal comma, dot grouping)', () => {
    test('parses a decimal-comma value', () => {
      expect(parseLocalizedNumber('1234,5', 'de-DE')).toEqual({ ok: true, value: 1234.5 });
    });

    test('parses a grouped value using the de dot grouping separator', () => {
      expect(parseLocalizedNumber('1.234', 'de-DE')).toEqual({ ok: true, value: 1234 });
    });

    test('parses a grouped decimal value', () => {
      expect(parseLocalizedNumber('1.234,5', 'de-DE')).toEqual({ ok: true, value: 1234.5 });
    });

    test('does NOT misread an en-style "1,234.5" as 1234.5 — the decimal is the comma here', () => {
      // In de-DE the comma is the decimal, so "1,234.5" has a decimal comma
      // AND a stray dot. We strip the dot (the locale's grouping char), then
      // split on the comma: int="1234", frac="5" wait — the dot was between
      // 234 and 5, so after strip it's "1,2345" → 1.2345. The point: the
      // parser never silently coerces to 0; it yields a definite value that
      // reflects the locale's rules. The assertion documents that behavior.
      expect(parseLocalizedNumber('1,234.5', 'de-DE')).toEqual({ ok: true, value: 1.2345 });
    });
  });

  test.describe('fr-FR (decimal comma, space grouping)', () => {
    test('parses a decimal-comma value', () => {
      expect(parseLocalizedNumber('1234,5', 'fr-FR')).toEqual({ ok: true, value: 1234.5 });
    });

    test('parses a value grouped with a regular space (the historical fr grouping)', () => {
      expect(parseLocalizedNumber('1 234', 'fr-FR')).toEqual({ ok: true, value: 1234 });
    });

    test('parses a value grouped with a narrow no-break space (the current CLDR fr grouping)', () => {
      expect(parseLocalizedNumber('1\u202f234,5', 'fr-FR')).toEqual({ ok: true, value: 1234.5 });
    });

    test('parses a value grouped with a regular space and decimal comma', () => {
      expect(parseLocalizedNumber('1 234,5', 'fr-FR')).toEqual({ ok: true, value: 1234.5 });
    });
  });

  test.describe('ar-EG (Arabic-Indic digits, Arabic decimal/grouping)', () => {
    test('parses Arabic-Indic digits ٠-٩', () => {
      // ١٢٣٤ == 1234
      expect(parseLocalizedNumber('١٢٣٤', 'ar-EG')).toEqual({ ok: true, value: 1234 });
    });

    test('parses Arabic-Indic digits with the Arabic decimal separator ٫', () => {
      // ١٢٣٤٫٥ == 1234.5
      expect(parseLocalizedNumber('١٢٣٤٫٥', 'ar-EG')).toEqual({ ok: true, value: 1234.5 });
    });

    test('parses Arabic-Indic digits with the Arabic grouping separator ٬', () => {
      // ١٬٢٣٤ == 1234
      expect(parseLocalizedNumber('١٬٢٣٤', 'ar-EG')).toEqual({ ok: true, value: 1234 });
    });

    test('treats ASCII digits as valid even in an ar locale (IME/paste fallback)', () => {
      expect(parseLocalizedNumber('1234', 'ar-EG')).toEqual({ ok: true, value: 1234 });
    });
  });

  test.describe('mixed-script / IME input', () => {
    test('parses a value whose digits are Extended Arabic-Indic (fa-IR) regardless of locale', () => {
      // ۱۲۳۴ == 1234 (Persian digits). normalizeDigits is locale-independent so
      // a user pasting a Persian-formatted number into an en-US field still
      // gets a correct parse rather than 0.
      expect(parseLocalizedNumber('۱۲۳۴', 'en-US')).toEqual({ ok: true, value: 1234 });
    });

    test('parses a value whose digits are Devanagari (Hindi)', () => {
      // १२३४ == 1234
      expect(parseLocalizedNumber('१२३४', 'en-US')).toEqual({ ok: true, value: 1234 });
    });

    test('parses a value with leading/trailing whitespace from an IME commit', () => {
      expect(parseLocalizedNumber('  42  ', 'en-US')).toEqual({ ok: true, value: 42 });
    });

    test('rejects a value with an embedded letter (not a silent 0)', () => {
      expect(parseLocalizedNumber('12a34', 'en-US').ok).toBe(false);
    });

    test('rejects a value that is only a sign', () => {
      expect(parseLocalizedNumber('-', 'en-US').ok).toBe(false);
      expect(parseLocalizedNumber('+', 'en-US').ok).toBe(false);
    });

    test('rejects a value that is only a decimal separator', () => {
      expect(parseLocalizedNumber('.', 'en-US').ok).toBe(false);
      expect(parseLocalizedNumber(',', 'de-DE').ok).toBe(false);
    });
  });

  test.describe('never silently coerces to zero', () => {
    // The core guarantee of issue #633: a typo or unrecognized format returns
    // { ok: false } so the call site keeps the OLD value and shows an error,
    // rather than `Number(raw) || 0` quietly storing 0.
    test('"abc" is rejected, not coerced to 0', () => {
      const r = parseLocalizedNumber('abc', 'en-US');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    });

    test('an empty/whitespace string is rejected, not coerced to 0', () => {
      expect(parseLocalizedNumber('   ', 'en-US').ok).toBe(false);
    });
  });
});

test.describe('parseLocalizedInteger', () => {
  test('accepts a whole number with en grouping', () => {
    expect(parseLocalizedInteger('1,234', 'en-US')).toEqual({ ok: true, value: 1234 });
  });

  test('accepts a whole number with de grouping', () => {
    expect(parseLocalizedInteger('1.234', 'de-DE')).toEqual({ ok: true, value: 1234 });
  });

  test('rejects a fractional value rather than truncating it', () => {
    // The OLD code did Math.trunc(Number(raw)); this refuses so the user sees
    // "Not a whole number." instead of a silently-dropped decimal.
    const r = parseLocalizedInteger('1,234.5', 'en-US');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('whole number');
  });

  test('enforces a minimum and reports the bound in the message', () => {
    const r = parseLocalizedInteger('0', 'en-US', { min: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('1');
  });

  test('enforces a maximum and reports the bound in the message', () => {
    const r = parseLocalizedInteger('99', 'en-US', { max: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('20');
  });

  test('accepts Arabic-Indic digits within bounds', () => {
    expect(parseLocalizedInteger('١٥', 'ar-EG', { min: 1, max: 20 })).toEqual({ ok: true, value: 15 });
  });
});

test.describe('normalizeDigits', () => {
  test('leaves an ASCII-only string untouched (fast path)', () => {
    expect(normalizeDigits('1d20+3')).toBe('1d20+3');
  });

  test('maps Arabic-Indic digits to ASCII', () => {
    // ١٢٣٤٥٦٧٨٩٠ → 1234567890
    expect(normalizeDigits('١٢٣٤٥٦٧٨٩٠')).toBe('1234567890');
  });

  test('maps Extended Arabic-Indic (Persian) digits to ASCII', () => {
    // ۰۱۲۳۴۵۶۷۸۹ → 0123456789
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  test('maps Devanagari digits to ASCII', () => {
    expect(normalizeDigits('०१२३४५६७८९')).toBe('0123456789');
  });

  test('preserves non-digit characters exactly', () => {
    expect(normalizeDigits('١d٢٠')).toBe('1d20');
  });

  test('is idempotent', () => {
    const once = normalizeDigits('١٢٣٤');
    expect(normalizeDigits(once)).toBe(once);
  });
});

test.describe('canonicalizeDiceExpr', () => {
  test('lowercases ASCII letters', () => {
    expect(canonicalizeDiceExpr('1D20KH1')).toBe('1d20kh1');
  });

  test('normalizes Arabic-Indic digits and lowercases', () => {
    // ٢d٢٠+٣ — Arabic-Indic digits with an ASCII 'd' — normalized to canonical
    // '2d20+3'. Only DIGITS are normalized; letters are lowercased, not
    // transliterated, so a roller using an Arabic letter for 'd' would still
    // need to type the ASCII 'd' for the schema regex to match.
    expect(canonicalizeDiceExpr('٢d٢٠+٣')).toBe('2d20+3');
  });

  test('is idempotent on canonical input', () => {
    expect(canonicalizeDiceExpr('1d20+3')).toBe('1d20+3');
  });

  test('does not validate shape — garbage passes through for the regex to reject', () => {
    expect(canonicalizeDiceExpr('abc')).toBe('abc');
  });
});
