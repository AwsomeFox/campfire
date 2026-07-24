/**
 * Custom accent safety (issue #795).
 *
 * Pins the pure palette builder: full tonal ramp generation, contrast repair
 * for hostile seeds (black / white / background-match / low-chroma / saturated),
 * and color-vision simulations so essential surfaces stay distinguishable.
 */
import { expect, test } from '@playwright/test';
import {
  ACCENT_CHIP_CONTRAST,
  ACCENT_CONTRAST_BG,
  ACCENT_CSS_VARS,
  ACCENT_TEXT_CONTRAST,
  ACCENT_UI_CONTRAST,
  accentMeetsContrastFloors,
  applyAccentColor,
  buildAccentPalette,
  contrastRatio,
  DEFAULT_ACCENT,
  evaluateAccentSafety,
  normalizeHex,
  paletteToCssVars,
  RAMP_STEPS,
  simulateColorVision,
  type ColorVisionSim,
} from '../../src/app/accentPalette';

const EDGE_SEEDS = {
  black: '#000000',
  white: '#ffffff',
  backgroundMatch: ACCENT_CONTRAST_BG,
  lowChroma: '#5a5a62',
  saturated: '#ff00aa',
  nocturne: DEFAULT_ACCENT,
  ember: '#e28d4f',
} as const;

const CVD: ColorVisionSim[] = ['protanopia', 'deuteranopia', 'tritanopia'];

test.describe('accent palette builder (#795)', () => {
  test('normalizeHex accepts #rrggbb and bare rrggbb, rejects junk', () => {
    expect(normalizeHex('#9184d9')).toBe('#9184d9');
    expect(normalizeHex('E28D4F')).toBe('#e28d4f');
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex('not-a-color')).toBeNull();
    expect(normalizeHex('#fff')).toBeNull();
  });

  test('default Nocturne seed produces a full ramp and meets contrast floors', () => {
    const palette = buildAccentPalette(DEFAULT_ACCENT);
    for (const step of RAMP_STEPS) {
      expect(palette.ramp[step]).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.ramp2[step]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(palette.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.accent2).toMatch(/^#[0-9a-f]{6}$/);
    expect(accentMeetsContrastFloors(palette)).toBe(true);
    const safety = evaluateAccentSafety(palette);
    expect(safety.link).toBeGreaterThanOrEqual(ACCENT_TEXT_CONTRAST);
    expect(safety.focus).toBeGreaterThanOrEqual(ACCENT_UI_CONTRAST);
    expect(safety.chip).toBeGreaterThanOrEqual(ACCENT_CHIP_CONTRAST);
  });

  for (const [name, seed] of Object.entries(EDGE_SEEDS)) {
    test(`${name} (${seed}) yields a safe full palette`, () => {
      const palette = buildAccentPalette(seed);
      expect(Object.keys(palette.ramp)).toHaveLength(RAMP_STEPS.length);
      expect(accentMeetsContrastFloors(palette)).toBe(true);

      // Hostile seeds must be repaired away from the shell background.
      if (name === 'black' || name === 'backgroundMatch' || name === 'lowChroma') {
        expect(palette.repaired).toBe(true);
        expect(palette.accent.toLowerCase()).not.toBe(ACCENT_CONTRAST_BG);
        expect(contrastRatio(palette.accent, ACCENT_CONTRAST_BG)).toBeGreaterThanOrEqual(
          ACCENT_TEXT_CONTRAST,
        );
      }
    });
  }

  test('paletteToCssVars covers every accent token consumers read', () => {
    const vars = paletteToCssVars(buildAccentPalette('#57afe0'));
    for (const name of ACCENT_CSS_VARS) {
      expect(vars[name], name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('applyAccentColor sets and clears the full token set on a style host', () => {
    const store = new Map<string, string>();
    const root = {
      setProperty(name: string, value: string) {
        store.set(name, value);
      },
      removeProperty(name: string) {
        store.delete(name);
      },
    } as unknown as CSSStyleDeclaration;

    const applied = applyAccentColor('#e28d4f', root);
    expect(applied).not.toBeNull();
    expect(store.get('--color-accent')).toBe(applied!.accent);
    expect(store.get('--cf-accent')).toBe(applied!.accent);
    expect(store.get('--color-accent-700')).toBe(applied!.ramp[700]);
    expect(store.get('--color-accent-2-100')).toBe(applied!.ramp2[100]);

    applyAccentColor(null, root);
    expect(store.size).toBe(0);
  });

  test('color-vision simulations keep essential contrast usable', () => {
    for (const seed of Object.values(EDGE_SEEDS)) {
      const palette = buildAccentPalette(seed);
      for (const sim of CVD) {
        const accent = simulateColorVision(palette.accent, sim);
        const bg = simulateColorVision(ACCENT_CONTRAST_BG, sim);
        const chipFg = simulateColorVision(palette.ramp[100], sim);
        const chipBg = simulateColorVision(palette.ramp[800], sim);
        // CVD softens some pairs; keep a UI-non-text floor so links/focus/chips
        // never collapse into the shell under protanopia/deuteranopia/tritanopia.
        expect(
          contrastRatio(accent, bg),
          `${seed} accent under ${sim}`,
        ).toBeGreaterThanOrEqual(ACCENT_UI_CONTRAST);
        expect(
          contrastRatio(chipFg, chipBg),
          `${seed} chip under ${sim}`,
        ).toBeGreaterThanOrEqual(ACCENT_UI_CONTRAST);
      }
    }
  });
});
