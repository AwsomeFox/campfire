/**
 * The catch-up panel's "since …" label must not append a second relative suffix.
 *
 * `timeAgo()` already returns a COMPLETE phrase — "28d ago", "3h ago", "just now", and an
 * absolute date once the gap passes 30 days. The panel used to feed that through a
 * `catchUp.timeAgo` string of `"{{time}} ago"`, which appended a second suffix to every
 * branch. On the dashboard it read:
 *
 *     6 updates across the campaign since 28d ago ago.
 *
 * and the other branches were worse in kind, not just degree: "since just now ago", and —
 * past 30 days, where `timeAgo` switches to a locale date — "since 8/10/2026 ago", which
 * pins a relative suffix onto an absolute date.
 *
 * Asserted against `timeAgo`'s real output rather than a hardcoded string, so this stays
 * honest if the helper's formatting changes.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { timeAgo } from '../../src/lib/format';

const ROOT = resolve(__dirname, '../../src');
const panel = readFileSync(resolve(ROOT, 'features/dashboard/CatchUpPanel.tsx'), 'utf8');
const enCatchUp = JSON.parse(readFileSync(resolve(ROOT, 'i18n/locales/en/catchUp.json'), 'utf8'));

test.describe('catch-up since label (relative-suffix duplication)', () => {
  test('timeAgo already carries its own suffix in every branch', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Each of these is a complete phrase on its own — nothing may be appended to them.
    expect(timeAgo(now - 28 * day, now)).toMatch(/ago$/);
    expect(timeAgo(now - 3 * 60 * 60 * 1000, now)).toMatch(/ago$/);
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    // Past 30 days it is an absolute date, where a relative suffix would be nonsense.
    expect(timeAgo(now - 400 * day, now)).not.toMatch(/ago/);
  });

  test('the panel uses that phrase directly and the wrapper string is gone', () => {
    expect(panel).toContain('timeAgo(data.since)');
    expect(panel).not.toContain("t('catchUp.timeAgo'");
    expect(enCatchUp.catchUp).not.toHaveProperty('timeAgo');
  });

  test('no catchUp string re-appends a relative suffix around an interpolated time', () => {
    for (const [key, value] of Object.entries(enCatchUp.catchUp as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      expect(
        /\{\{time\}\}\s*ago\b/.test(value),
        `catchUp.${key} appends "ago" to an already-complete phrase: ${value}`,
      ).toBe(false);
    }
  });
});
