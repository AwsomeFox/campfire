/** Pure battle-map token-state rendering rules (issue #1905). */
import { expect, test } from '@playwright/test';
import {
  HP_BAND_FRACTION,
  TOKEN_DETAIL_STORAGE_KEY,
  parseTokenDetailMode,
  readTokenDetailMode,
  tokenArcGeometry,
  tokenBadgePlacements,
  tokenConditionBadges,
  tokenConditionFallback,
  tokenConditionGlyph,
  tokenDeathMarker,
  tokenHpFraction,
  tokenHpTone,
  writeTokenDetailMode,
} from '../../src/features/encounters/tokenStateBadges';
import { hpBandFor } from '../../src/features/screen/playerSafe';

test.describe('token HP state (issue #1905)', () => {
  test('uses exact HP only when the role-shaped combatant supplies it', () => {
    expect(tokenHpFraction({ hpCurrent: 75, hpMax: 100, hpBand: null })).toBe(0.75);
    expect(tokenHpFraction({ hpCurrent: -5, hpMax: 100, hpBand: null })).toBe(0);
    expect(tokenHpFraction({ hpCurrent: 150, hpMax: 100, hpBand: null })).toBe(1);
    expect(tokenHpFraction({ hpCurrent: null, hpMax: null, hpBand: null })).toBeNull();
  });

  test('redacted values expose exactly the existing four bands', () => {
    const cases = [
      { current: 100, max: 100, band: 'healthy' as const },
      { current: 51, max: 100, band: 'healthy' as const },
      { current: 50, max: 100, band: 'bloodied' as const },
      { current: 26, max: 100, band: 'bloodied' as const },
      { current: 25, max: 100, band: 'critical' as const },
      { current: 1, max: 100, band: 'critical' as const },
      { current: 0, max: 100, band: 'down' as const },
    ];
    for (const { current, max, band } of cases) {
      expect(hpBandFor(current, max)).toBe(band);
      expect(tokenHpFraction({ hpCurrent: null, hpMax: null, hpBand: band })).toBe(HP_BAND_FRACTION[band]);
    }
    expect(new Set(Object.values(HP_BAND_FRACTION))).toEqual(new Set([1, 0.5, 0.2, 0]));
  });

  test('selects green, amber, red, and down arc tones without numeric display text', () => {
    expect(tokenHpTone(0.8)).toBe('healthy');
    expect(tokenHpTone(0.5)).toBe('bloodied');
    expect(tokenHpTone(0.25)).toBe('critical');
    expect(tokenHpTone(0)).toBe('down');
    expect(tokenHpTone(null)).toBeNull();
  });

  test('keeps SVG arcs inside a token at every supported footprint scale', () => {
    for (const size of [18, 32, 64, 128]) {
      const arc = tokenArcGeometry(size);
      expect(arc.radius + arc.strokeWidth / 2).toBeLessThan(size / 2);
      expect(arc.circumference).toBeGreaterThan(0);
    }
  });
});

test.describe('token condition badges (issue #1905)', () => {
  test('maps familiar conditions to glyphs and homebrew conditions to an initial', () => {
    expect(tokenConditionGlyph('Poisoned')).toBe('poison-bottle');
    expect(tokenConditionGlyph('restrained')).toBe('rope-coil');
    expect(tokenConditionGlyph('Gravity-sick')).toBeNull();
    expect(tokenConditionFallback('Gravity-sick')).toBe('G');
    expect(tokenConditionFallback('  ')).toBe('?');
  });

  test('limits visual badges to three with accurate overflow counts', () => {
    expect(tokenConditionBadges([])).toMatchObject({ visible: [], overflow: 0 });
    expect(tokenConditionBadges(['a', 'b', 'c'])).toMatchObject({ overflow: 0 });
    expect(tokenConditionBadges(['a', 'b', 'c', 'd'])).toMatchObject({ overflow: 1 });
    expect(tokenConditionBadges(Array.from({ length: 10 }, (_, i) => `condition ${i}`))).toMatchObject({ overflow: 7 });
  });

  test('keeps 18px condition hit targets clear of the unplace corner', () => {
    for (const size of [18, 24, 32, 64, 128]) {
      const unplace = { left: size - 10, top: -6, right: size + 6, bottom: 10 };
      for (const badge of tokenBadgePlacements(size, 3)) {
        expect(badge.targetSize).toBeGreaterThanOrEqual(18);
        const x = (badge.left / 100) * size;
        const y = (badge.top / 100) * size;
        const rect = {
          left: x - badge.targetSize / 2,
          top: y - badge.targetSize / 2,
          right: x + badge.targetSize / 2,
          bottom: y + badge.targetSize / 2,
        };
        const intersects = rect.left < unplace.right && rect.right > unplace.left && rect.top < unplace.bottom && rect.bottom > unplace.top;
        expect(intersects).toBe(false);
      }
    }
  });
});

test.describe('token death and detail mode (issue #1905)', () => {
  test('keeps dying distinct from dead and treats a redacted down monster as dead', () => {
    expect(tokenDeathMarker({ kind: 'character', hpCurrent: 0, hpBand: null, deathState: 'dying' })).toBe('dying');
    expect(tokenDeathMarker({ kind: 'character', hpCurrent: 0, hpBand: null, deathState: 'dead' })).toBe('dead');
    expect(tokenDeathMarker({ kind: 'monster', hpCurrent: null, hpBand: 'down', deathState: 'none' })).toBe('dead');
    expect(tokenDeathMarker({ kind: 'monster', hpCurrent: 1, hpBand: null, deathState: 'none' })).toBeNull();
  });

  test('persists only valid DM detail modes and safely defaults when storage fails', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readTokenDetailMode(storage)).toBe('full');
    expect(writeTokenDetailMode('minimal', storage)).toBe(true);
    expect(values.get(TOKEN_DETAIL_STORAGE_KEY)).toBe('minimal');
    expect(readTokenDetailMode(storage)).toBe('minimal');
    expect(parseTokenDetailMode('unexpected')).toBe('full');
    expect(readTokenDetailMode({ getItem: () => { throw new Error('blocked'); } })).toBe('full');
    expect(writeTokenDetailMode('off', { setItem: () => { throw new Error('blocked'); } })).toBe(false);
  });
});
