/**
 * The catch-up panel's "since …" label must not append a second relative suffix.
 *
 * `timeAgo()` already returns a COMPLETE phrase — "28d ago", "3h ago", "just now", and an
 * absolute date once the gap passes 30 days. The panel used to feed that through a
 * `catchUp.timeAgo` string of `"{{time}} ago"`, which appended a second suffix. On the
 * dashboard it read:
 *
 *     6 updates across the campaign since 28d ago ago.
 *
 * and the other branches were worse in kind, not just degree: "since just now ago", and —
 * past 30 days, where `timeAgo` switches to a locale date — "since 8/10/2026 ago", which
 * pins a relative suffix onto an absolute one.
 */
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocaleFormatters, formatDate, timeAgo } from '../../src/lib/format';

const ROOT = resolve(__dirname, '../../src');
const LOCALES_DIR = resolve(ROOT, 'i18n/locales');
const panel = readFileSync(resolve(ROOT, 'features/dashboard/CatchUpPanel.tsx'), 'utf8');

const DAY = 24 * 60 * 60 * 1000;

/** Every locale catalogue that carries catchUp strings, not just English. */
function catchUpCatalogues(): Array<{ locale: string; strings: Record<string, unknown> }> {
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = resolve(LOCALES_DIR, entry.name, 'catchUp.json');
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      return [{ locale: entry.name, strings: (JSON.parse(raw).catchUp ?? {}) as Record<string, unknown> }];
    });
}

test.describe('catch-up since label (relative-suffix duplication)', () => {
  /**
   * Pinned to en-US via `createLocaleFormatters` rather than asserted against the ambient
   * locale. `timeAgo` resolves `Intl.RelativeTimeFormat` from the runtime locale, so
   * matching English tokens against the shared export would have been a test that passed
   * because of the environment rather than because of the code.
   */
  test('the relative branch already carries its own suffix (en-US)', () => {
    const en = createLocaleFormatters(() => 'en-US');
    const now = Date.now();
    expect(en.timeAgo(now - 28 * DAY, now)).toMatch(/ago$/);
    expect(en.timeAgo(now - 3 * 60 * 60 * 1000, now)).toMatch(/ago$/);
    expect(en.timeAgo(now - 10_000, now)).toBe('just now');
  });

  /**
   * The locale-independent half of the same invariant: past 30 days `timeAgo` stops being
   * relative and hands back the very same string `formatDate` produces, which is why
   * appending "ago" to it was nonsense in any language.
   */
  test('past 30 days it is the absolute date, in whatever locale is active', () => {
    const now = Date.now();
    const old = now - 400 * DAY;
    expect(timeAgo(old, now)).toBe(formatDate(old));
    // …and a recent timestamp is NOT that absolute date, i.e. it really is the relative branch.
    expect(timeAgo(now - 2 * DAY, now)).not.toBe(formatDate(now - 2 * DAY));
  });

  test('the panel uses that phrase directly and the wrapper string is gone everywhere', () => {
    expect(panel).toContain('timeAgo(data.since)');
    expect(panel).not.toContain("t('catchUp.timeAgo'");

    const catalogues = catchUpCatalogues();
    // Guard the guard: if the catalogues ever move, this must fail loudly rather than
    // silently assert over an empty list.
    expect(catalogues.length, 'expected at least one catchUp catalogue').toBeGreaterThan(0);
    for (const { locale, strings } of catalogues) {
      expect(strings, `${locale}/catchUp.json still defines the removed wrapper`).not.toHaveProperty('timeAgo');
    }
  });

  /**
   * Locale-independent, and narrow on purpose: what must never happen is WORDS following
   * `{{time}}`, because `timeAgo` already ends the phrase. Leading text is fine
   * ("Scheduled {{time}}"), and so is trailing punctuation ("… since {{time}}."); it is a
   * trailing WORD that re-suffixes an already-complete phrase, in any language.
   */
  test('no catchUp string in any locale appends a word after the interpolated time', () => {
    for (const { locale, strings } of catchUpCatalogues()) {
      for (const [key, value] of Object.entries(strings)) {
        if (typeof value !== 'string') continue;
        const trailing = value.split('{{time}}').slice(1).join('{{time}}');
        expect(
          /[\p{L}\p{N}]/u.test(trailing),
          `${locale} catchUp.${key} appends text after an already-complete phrase: ${value}`,
        ).toBe(false);
      }
    }
  });
});
