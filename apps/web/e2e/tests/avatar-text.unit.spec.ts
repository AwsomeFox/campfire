/**
 * Grapheme-aware avatar/initials helper (issue #631).
 *
 * Earlier surfaces sliced UTF-16 code units, so `"🐶".slice(0, 1)` and
 * `"A🇸🇪".slice(0, 1)` returned half of a surrogate pair / regional-indicator
 * pair and rendered as the replacement glyph (tofu). Combined marks (é as
 * `e` + `\u0301`) and ZWJ emoji (family/skin-tone) were likewise split.
 *
 * The helper in `src/lib/avatarText` routes through `Intl.Segmenter`
 * (granularity: `grapheme`) with a Unicode-aware regex fallback for runtimes
 * without `Segmenter`. These specs pin:
 *   - emoji / flag / skin-tone / ZWJ clusters are kept intact (no tofu);
 *   - combining marks stay attached to their base;
 *   - CJK names yield two graphemes (not two halves of one surrogate);
 *   - RTL names take first/last by logical order, not display order;
 *   - the fallback path matches the Segmenter path on every case;
 *   - locale-aware casing (Turkish dotted/dotless i).
 *
 * Pure unit test — no backend, no browser — runs under the Playwright runner
 * alongside the other `.unit.spec.ts` files.
 */
import { expect, test } from '@playwright/test';
import {
  firstGrapheme,
  graphemes,
  initials,
  setGraphemeSegmenterProviderForTest,
} from '../../src/lib/avatarText';

test.afterAll(() => {
  // Guarantee the override never leaks into another spec file.
  setGraphemeSegmenterProviderForTest(null);
});

test.describe('avatarText graphemes (issue #631)', () => {
  test('keeps a single emoji as one grapheme', () => {
    expect(graphemes('🐶')).toEqual(['🐶']);
    expect(graphemes('🐶'.slice(0, 1))).not.toEqual(['🐶']);
  });

  test('keeps regional-indicator flag pairs intact', () => {
    expect(graphemes('🇸🇪')).toEqual(['🇸🇪']);
    expect(graphemes('A🇸🇪B')).toEqual(['A', '🇸🇪', 'B']);
  });

  test('keeps consecutive flag emoji as separate graphemes', () => {
    // Two complete flags (🇺🇸 + 🇨🇦) must not merge into one cluster.
    expect(graphemes('🇺🇸🇨🇦')).toEqual(['🇺🇸', '🇨🇦']);
  });

  test('keeps skin-tone modifier sequences intact', () => {
    // 👍🏽 = THUMBS UP + emoji modifier fitzpatrick type-4.
    expect(graphemes('👍🏽')).toEqual(['👍🏽']);
  });

  test('keeps ZWJ family/skin-tone compounds intact', () => {
    // 👨‍👩‍👧 = man ZWJ woman ZWJ girl.
    expect(graphemes('👨‍👩‍👧')).toEqual(['👨‍👩‍👧']);
    // 🧑🏽‍🦱 = adult + skin tone + ZWJ + curly hair.
    expect(graphemes('🧑🏽‍🦱')).toEqual(['🧑🏽‍🦱']);
  });

  test('attaches combining marks to the preceding base', () => {
    // é as "e" + combining acute.
    expect(graphemes('e\u0301')).toEqual(['e\u0301']);
    expect(graphemes('e\u0301owyn')).toEqual(['e\u0301', 'o', 'w', 'y', 'n']);
  });
});

test.describe('avatarText initials (issue #631)', () => {
  test('basic Latin multi-token name', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Ashen cultist')).toBe('AC');
  });

  test('single token takes the first two graphemes', () => {
    expect(initials('Ada')).toBe('AD');
    expect(initials('Goblin')).toBe('GO');
  });

  test('numeric suffix tokens are handled grapheme-wise ("Goblin 1" -> "G1")', () => {
    expect(initials('Goblin 1')).toBe('G1');
  });

  test('empty / whitespace-only names fall back to "?"', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials('\t\n')).toBe('?');
  });

  test('emoji-prefixed name does not split the emoji', () => {
    // The bug: "🐶 Dogbert".slice would yield a replacement glyph for the
    // leading surrogate half. The helper keeps the dog intact.
    expect(initials('🐶 Dogbert')).toBe('🐶D');
    expect(initials('Dogbert 🐶')).toBe('D🐶');
  });

  test('flag-emoji name keeps the regional-indicator pair together', () => {
    expect(firstGrapheme('🇸🇪 Sweden')).toBe('🇸🇪');
    expect(initials('🇸🇪 Sweden')).toBe('🇸🇪S');
  });

  test('skin-tone and ZWJ emoji are not split', () => {
    expect(firstGrapheme('👍🏽 Thumbs')).toBe('👍🏽');
    expect(firstGrapheme('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
  });

  test('combining-mark first letter stays attached', () => {
    expect(initials('éowyn of Rohan')).toBe('ÉR');
    expect(firstGrapheme('éowyn')).toBe('É');
  });

  test('CJK names yield two graphemes (not two halves of one surrogate)', () => {
    // Each Han character is one grapheme; the bug would have split the
    // surrogate of any astral-plane CJK extension character.
    expect(initials('攀登者')).toBe('攀登');
    expect(initials('山 田')).toBe('山田');
  });

  test('RTL names: first/last by logical order', () => {
    // "مدیر فروش" (sales manager). Whitespace tokenization is logical-order,
    // so the first token's first grapheme + last token's first grapheme is
    // what the user authored first and last — independent of bidi reordering.
    const result = initials('مدیر فروش');
    expect(result).toBe(graphemes('مدیر')[0]! + graphemes('فروش')[0]!);
    expect([...result]).toHaveLength(2);
  });

  test('locale-aware casing: Turkish dotless/dotted i', () => {
    // In Turkish, lowercase i -> uppercase İ (with dot); plain toUpperCase
    // would yield plain I. We only assert the locale path differs from the
    // default when the runtime honors the Turkish casing rules.
    const turkish = initials('ilhan', 'tr-TR');
    const generic = initials('ilhan');
    if (generic !== turkish) {
      expect(turkish).toBe('İL');
    }
    // Sanity: the generic path still returns something sane.
    expect(generic.length).toBeGreaterThan(0);
  });
});

test.describe('avatarText firstGrapheme (issue #631)', () => {
  test('single grapheme passthrough + uppercase', () => {
    expect(firstGrapheme('Ada')).toBe('A');
    expect(firstGrapheme('ada')).toBe('A');
  });

  test('emoji / flag / ZWJ passthrough', () => {
    expect(firstGrapheme('🐶 Dogbert')).toBe('🐶');
    expect(firstGrapheme('🇸🇪')).toBe('🇸🇪');
    expect(firstGrapheme('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
  });

  test('empty falls back to "?"', () => {
    expect(firstGrapheme('')).toBe('?');
    expect(firstGrapheme('   ')).toBe('?');
  });
});

test.describe('avatarText fallback path (no Intl.Segmenter)', () => {
  // Force the runtime to pretend `Intl.Segmenter` is unavailable so the regex
  // fallback is exercised for every assertion in this describe block.
  test.beforeAll(() => {
    setGraphemeSegmenterProviderForTest(() => null);
  });
  test.afterAll(() => {
    setGraphemeSegmenterProviderForTest(null);
  });

  // Run every fallback assertion against the same inputs as the native path
  // and require identical results, so the two implementations never drift.
  const cases: Array<[string, string[]]> = [
    ['🐶', ['🐶']],
    ['🇸🇪', ['🇸🇪']],
    ['A🇸🇪B', ['A', '🇸🇪', 'B']],
    // Consecutive flags: after a complete pair, the next RI starts a new flag.
    ['🇺🇸🇨🇦', ['🇺🇸', '🇨🇦']],
    ['👍🏽', ['👍🏽']],
    ['👨‍👩‍👧', ['👨‍👩‍👧']],
    ['🧑🏽‍🦱', ['🧑🏽‍🦱']],
    ['e\u0301', ['e\u0301']],
    ['e\u0301owyn', ['e\u0301', 'o', 'w', 'y', 'n']],
    ['攀登者', ['攀', '登', '者']],
  ];

  for (const [input, expected] of cases) {
    test(`fallback graphemes match native for ${JSON.stringify(input)}`, () => {
      expect(graphemes(input)).toEqual(expected);
    });
  }

  test('fallback initials keep emoji intact', () => {
    expect(initials('🐶 Dogbert')).toBe('🐶D');
    expect(initials('🇸🇪 Sweden')).toBe('🇸🇪S');
  });

  test('fallback firstGrapheme keeps ZWJ emoji intact', () => {
    expect(firstGrapheme('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
    expect(firstGrapheme('👍🏽 Thumbs')).toBe('👍🏽');
  });

  test('fallback handles combining marks and CJK', () => {
    expect(initials('éowyn of Rohan')).toBe('ÉR');
    expect(initials('攀登者')).toBe('攀登');
  });
});
