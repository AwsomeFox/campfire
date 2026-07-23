import { expect, test } from '@playwright/test';
import { hpTone } from '../../src/components/ui';

/**
 * Issue #642 — HP color semantics must be consistent across surfaces.
 *
 * Before this change the combat tracker's shared `<HpBar>` toned red below
 * 25% and amber below 50%, while the Party card and character sheet rendered
 * a flat blurple bar at every HP level. The fix routes all three surfaces
 * through the same `hpTone` helper; these specs pin the threshold contract
 * that "near-dead" and "bloodied" ride on, so a future tweak to one surface
 * can't silently diverge from the others again.
 *
 * The thresholds mirror `.cf-hp` / `.cf-hp.low` / `.cf-hp.crit` in index.css
 * and the rendered `<HpBar>` uses this helper directly.
 */
test.describe('hpTone — shared HP danger ramp (issue #642)', () => {
  test.describe('crit band — below 25% of max', () => {
    test('a freshly-dropped 5/30 PC (the issue repro) is crit', () => {
      expect(hpTone(5, 30)).toBe('crit');
    });

    test('exactly 24% reads as crit (strict less-than-25)', () => {
      expect(hpTone(24, 100)).toBe('crit');
    });

    test('1 HP on a 100 HP buffer is still crit, not a special-case', () => {
      expect(hpTone(1, 100)).toBe('crit');
    });
  });

  test.describe('low band — 25% up to (but not including) 50%', () => {
    test('exactly 25% graduates from crit to low', () => {
      expect(hpTone(25, 100)).toBe('low');
    });

    test('a bloodied 14/30 reads as low', () => {
      expect(hpTone(14, 30)).toBe('low');
    });

    test('exactly 49% is still low (strict less-than-50)', () => {
      expect(hpTone(49, 100)).toBe('low');
    });
  });

  test.describe('healthy band — 50% and above', () => {
    test('exactly half HP graduates from low to healthy', () => {
      expect(hpTone(50, 100)).toBe('');
    });

    test('full HP is healthy (no tone class)', () => {
      expect(hpTone(30, 30)).toBe('');
    });

    test('overheal (current > max) clamps to healthy, never tones', () => {
      expect(hpTone(40, 30)).toBe('');
    });
  });

  test.describe('degenerate max', () => {
    test('max 0 cannot divide — treats as 0% and tones crit', () => {
      // Guards the party card / sheet for a freshly-created character whose
      // max HP is momentarily 0; the bar should still render a sensible tone
      // rather than NaN'ing into an empty string.
      expect(hpTone(0, 0)).toBe('crit');
    });

    test('negative max is treated as 0% (crit), never a healthy false-positive', () => {
      expect(hpTone(-5, -10)).toBe('crit');
    });
  });
});
