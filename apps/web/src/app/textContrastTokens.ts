/**
 * Semantic text-color tokens (issue #593).
 *
 * Secondary, timestamp, disabled, and decorative roles each have a documented
 * contrast floor against every opaque shell background the app paints text on,
 * including common translucent tints (DM panels, accent chips, tab bar).
 *
 * Pure functions — safe to unit-test without a DOM.
 */
import { contrastRatio, hexToRgb, rgbToHex, type Rgb } from './accentPalette';

/** WCAG AA for normal essential text. */
export const TEXT_NORMAL_CONTRAST = 4.5;
/** WCAG AA for large text and non-text UI indicators. */
export const TEXT_LARGE_UI_CONTRAST = 3;

/** Opaque surfaces text is routinely placed on. */
export const TEXT_CONTRAST_BACKGROUNDS = {
  app: '#161826',
  surface: '#232532',
  neutral900: '#292b31',
  neutral800: '#3f424d',
} as const;

export type TextContrastBackground = keyof typeof TEXT_CONTRAST_BACKGROUNDS;

/**
 * Translucent tints composited over a base before contrast checks.
 * Percent is the color-mix weight of the tint color (remainder is transparent).
 */
export const TEXT_CONTRAST_MIXED_BACKGROUNDS: ReadonlyArray<{
  id: string;
  base: TextContrastBackground;
  tint: string;
  percent: number;
}> = [
  { id: 'dm-panel', base: 'surface', tint: '#9184d9', percent: 7 },
  { id: 'accent-chip', base: 'surface', tint: '#9184d9', percent: 16 },
  { id: 'reading-checked', base: 'surface', tint: '#9184d9', percent: 10 },
  { id: 'tabbar', base: 'surface', tint: '#232532', percent: 94 },
  { id: 'prose-row', base: 'surface', tint: '#e9e9ed', percent: 6 },
];

/** Semantic text tokens and their minimum contrast floors. */
export const SEMANTIC_TEXT_TOKENS = {
  '--color-text-secondary': { floor: TEXT_NORMAL_CONTRAST, role: 'secondary' },
  '--color-text-timestamp': { floor: TEXT_NORMAL_CONTRAST, role: 'timestamp' },
  '--color-text-disabled': { floor: TEXT_LARGE_UI_CONTRAST, role: 'disabled' },
  '--color-text-decorative': { floor: TEXT_LARGE_UI_CONTRAST, role: 'decorative' },
} as const;

export type SemanticTextToken = keyof typeof SEMANTIC_TEXT_TOKENS;

/** Canonical hex values — mirrored in index.css / nocturne.css. */
export const SEMANTIC_TEXT_TOKEN_VALUES: Record<SemanticTextToken, string> = {
  '--color-text-secondary': '#9da1b5',
  '--color-text-timestamp': '#9da1b5',
  '--color-text-disabled': '#8e92a6',
  '--color-text-decorative': '#868a9e',
};

/** Backgrounds where each role's copy is actually painted (issue #593 audit). */
export const ROLE_CONTRAST_BACKGROUNDS: Record<
  (typeof SEMANTIC_TEXT_TOKENS)[SemanticTextToken]['role'],
  ReadonlyArray<string>
> = {
  secondary: ['app', 'surface', 'dm-panel', 'reading-checked', 'tabbar', 'prose-row'],
  timestamp: ['app', 'surface', 'dm-panel', 'tabbar', 'prose-row'],
  disabled: ['app', 'surface', 'dm-panel', 'reading-checked', 'tabbar'],
  decorative: ['app', 'surface', 'accent-chip', 'prose-row'],
};

function compositeRgb(fg: Rgb, fgAlpha: number, bg: Rgb): Rgb {
  const a = Math.max(0, Math.min(1, fgAlpha));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** Composite `tint` at `percent` over `base` (color-mix with transparent). */
export function mixedBackgroundHex(base: string, tint: string, percent: number): string {
  const alpha = percent / 100;
  return rgbToHex(compositeRgb(hexToRgb(tint), alpha, hexToRgb(base)));
}

export function allContrastBackgrounds(): Array<{ id: string; hex: string }> {
  const opaque = Object.entries(TEXT_CONTRAST_BACKGROUNDS).map(([id, hex]) => ({ id, hex }));
  const mixed = TEXT_CONTRAST_MIXED_BACKGROUNDS.map(({ id, base, tint, percent }) => ({
    id,
    hex: mixedBackgroundHex(TEXT_CONTRAST_BACKGROUNDS[base], tint, percent),
  }));
  return [...opaque, ...mixed];
}

export type TextContrastFailure = {
  token: SemanticTextToken;
  background: string;
  ratio: number;
  floor: number;
};

/** Verify every semantic token meets its floor on every audited background. */
export function verifySemanticTextContrast(
  values: Record<SemanticTextToken, string> = SEMANTIC_TEXT_TOKEN_VALUES,
): TextContrastFailure[] {
  const failures: TextContrastFailure[] = [];
  const byId = new Map(allContrastBackgrounds().map((entry) => [entry.id, entry.hex]));
  for (const [token, meta] of Object.entries(SEMANTIC_TEXT_TOKENS) as Array<
    [SemanticTextToken, (typeof SEMANTIC_TEXT_TOKENS)[SemanticTextToken]]
  >) {
    const fg = values[token];
    for (const backgroundId of ROLE_CONTRAST_BACKGROUNDS[meta.role]) {
      const hex = byId.get(backgroundId);
      if (!hex) continue;
      const ratio = contrastRatio(fg, hex);
      if (ratio < meta.floor) {
        failures.push({ token, background: backgroundId, ratio, floor: meta.floor });
      }
    }
  }
  return failures;
}
