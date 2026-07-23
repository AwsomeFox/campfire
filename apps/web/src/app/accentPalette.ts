/**
 * Custom accent safety (issue #795).
 *
 * A personal accent used to override only `--color-accent` / `--color-accent-2`,
 * leaving the static blurple tonal ramp (100–900) and letting background-matching
 * picks erase links, focus rings, and borders. This module:
 *
 *   1. Derives a full Nocturne-shaped OKLCH ramp from one canonical hex
 *   2. Repairs lightness/chroma so essential surfaces keep WCAG contrast
 *   3. Applies (or clears) every accent token the design system consumes
 *
 * Pure functions — safe to unit-test without a DOM. `applyAccentColor` is the
 * document-level entry point used by AuthProvider and Preferences.
 */

export const DEFAULT_ACCENT = '#9184d9';
/** Nocturne app background — contrast anchor for links / focus / buttons. */
export const ACCENT_CONTRAST_BG = '#161826';
/** Minimum contrast for accent text/icons on the app background (WCAG AA). */
export const ACCENT_TEXT_CONTRAST = 4.5;
/** Minimum contrast for non-text UI (focus rings, borders) — WCAG 2.2. */
export const ACCENT_UI_CONTRAST = 3;
/** Chip/tag label on its filled background. */
export const ACCENT_CHIP_CONTRAST = 4.5;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Shared lightness ladder for Nocturne tonal ramps (accent-100 … accent-900). */
const RAMP_LIGHTNESS: Readonly<Record<RampStep, number>> = {
  100: 0.971,
  200: 0.931,
  300: 0.87,
  400: 0.78,
  500: 0.679,
  600: 0.58,
  700: 0.48,
  800: 0.38,
  900: 0.29,
};

/**
 * Chroma multipliers relative to the canonical accent chroma, matching the
 * curvature of the static blurple ramp (peak near 500–600, taper at ends).
 */
const RAMP_CHROMA_FACTOR: Readonly<Record<RampStep, number>> = {
  100: 0.12,
  200: 0.27,
  300: 0.52,
  400: 0.91,
  500: 1,
  600: 1,
  700: 0.83,
  800: 0.64,
  900: 0.38,
};

export type RampStep = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
export const RAMP_STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export type Oklch = { l: number; c: number; h: number };
export type Rgb = { r: number; g: number; b: number };

export type AccentPalette = {
  /** User-facing seed after contrast repair (written to --color-accent). */
  accent: string;
  accent2: string;
  ramp: Record<RampStep, string>;
  ramp2: Record<RampStep, string>;
  /** True when lightness/chroma were adjusted to meet contrast floors. */
  repaired: boolean;
  /** Seed hex before repair (normalized). */
  seed: string;
};

/** CSS custom properties set (or cleared) for a personal accent. */
export const ACCENT_CSS_VARS = [
  '--color-accent',
  '--cf-accent',
  '--color-accent-2',
  '--cf-accent-2',
  '--color-accent-100',
  '--color-accent-200',
  '--color-accent-300',
  '--color-accent-400',
  '--color-accent-500',
  '--color-accent-600',
  '--color-accent-700',
  '--color-accent-800',
  '--color-accent-900',
  '--color-accent-2-100',
  '--color-accent-2-200',
  '--color-accent-2-300',
  '--color-accent-2-400',
  '--color-accent-2-500',
  '--color-accent-2-600',
  '--color-accent-2-700',
  '--color-accent-2-800',
  '--color-accent-2-900',
] as const;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

export function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (!HEX_RE.test(withHash)) return null;
  return withHash.toLowerCase();
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

function srgbChannelToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(c: number): number {
  const x = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, x * 255));
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const R = srgbChannelToLinear(r);
  const G = srgbChannelToLinear(g);
  const B = srgbChannelToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** OKLab/OKLCH conversion (Björn Ottosson). */
export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = hexToRgb(hex);
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(a, b2);
  let h = (Math.atan2(b2, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

export function oklchToHex({ l, c, h }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const r = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const b2 = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return rgbToHex({
    r: linearToSrgbChannel(r),
    g: linearToSrgbChannel(g),
    b: linearToSrgbChannel(b2),
  });
}

/**
 * Simulate common color-vision deficiencies with a simple LMS matrix approach
 * (Machado / Viénot-style linearization). Used only for safety tests — not for
 * live rendering.
 */
export type ColorVisionSim = 'protanopia' | 'deuteranopia' | 'tritanopia';

const CVD_MATRICES: Record<ColorVisionSim, ReadonlyArray<ReadonlyArray<number>>> = {
  // Brettel-inspired linear RGB matrices (sRGB-linear domain), commonly used in a11y tooling.
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

export function simulateColorVision(hex: string, sim: ColorVisionSim): string {
  const { r, g, b } = hexToRgb(hex);
  const rgb = [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
  const m = CVD_MATRICES[sim];
  const out = [0, 0, 0].map((_, row) =>
    Math.max(0, m[row][0] * rgb[0] + m[row][1] * rgb[1] + m[row][2] * rgb[2]),
  );
  return rgbToHex({
    r: linearToSrgbChannel(out[0]),
    g: linearToSrgbChannel(out[1]),
    b: linearToSrgbChannel(out[2]),
  });
}

function buildRamp(seed: Oklch, chromaScale = 1): Record<RampStep, string> {
  // Achromatic seeds still need a readable ramp — borrow Nocturne hue + a
  // modest chroma so chips/selected states don't collapse to grey-on-grey.
  const defaultHue = hexToOklch(DEFAULT_ACCENT).h;
  const chroma = seed.c < 0.02 ? 0.06 : seed.c;
  const hue = seed.c < 0.02 || !Number.isFinite(seed.h) ? defaultHue : seed.h;
  const out = {} as Record<RampStep, string>;
  for (const step of RAMP_STEPS) {
    out[step] = oklchToHex({
      l: RAMP_LIGHTNESS[step],
      c: chroma * chromaScale * RAMP_CHROMA_FACTOR[step],
      h: hue,
    });
  }
  return out;
}

/**
 * Raise or lower lightness until `hex` contrasts with `bg` by at least `min`.
 * Preserves hue; gently floors chroma so near-neutral seeds stay distinguishable.
 */
export function repairContrastAgainstBg(
  hex: string,
  bg: string = ACCENT_CONTRAST_BG,
  minRatio: number = ACCENT_TEXT_CONTRAST,
): { hex: string; repaired: boolean } {
  const normalized = hex.toLowerCase();
  if (contrastRatio(normalized, bg) >= minRatio) {
    return { hex: normalized, repaired: false };
  }

  const seed = hexToOklch(normalized);
  // Near-grey / achromatic seeds get a small chroma floor and the Nocturne hue
  // so the repaired ramp isn't a flat neutral (and black doesn't collapse to hue 0).
  const defaultHue = hexToOklch(DEFAULT_ACCENT).h;
  const chroma = seed.c < 0.02 ? 0.06 : seed.c;
  const hue = seed.c < 0.02 || !Number.isFinite(seed.h) ? defaultHue : seed.h;
  let l = seed.l;

  // Prefer lightening on Campfire's dark shell; if that fails, darken.
  const bgL = hexToOklch(bg).l;
  const direction = l <= bgL + 0.05 ? 1 : l < 0.55 ? 1 : -1;
  for (let i = 0; i < 40; i++) {
    l = Math.max(0.12, Math.min(0.95, l + direction * 0.02));
    const hexOut = oklchToHex({ l, c: chroma, h: hue });
    if (contrastRatio(hexOut, bg) >= minRatio) return { hex: hexOut, repaired: true };
  }
  // Last resort: push to a known-safe lightness band for dark UI.
  return {
    hex: oklchToHex({ l: 0.72, c: Math.max(chroma, 0.06), h: hue }),
    repaired: true,
  };
}

function ensureChipContrast(
  ramp: Record<RampStep, string>,
  seed: Oklch,
): Record<RampStep, string> {
  if (contrastRatio(ramp[100], ramp[800]) >= ACCENT_CHIP_CONTRAST) return ramp;
  const next = { ...ramp };
  next[100] = oklchToHex({ l: 0.98, c: seed.c * 0.1, h: seed.h });
  next[800] = oklchToHex({ l: 0.32, c: seed.c * 0.7, h: seed.h });
  return next;
}

/**
 * Build a complete accent palette from a user hex. Invalid hex throws —
 * callers should validate with `normalizeHex` first.
 */
export function buildAccentPalette(seedHex: string): AccentPalette {
  if (!isHexColor(seedHex)) {
    throw new Error(`buildAccentPalette: expected #rrggbb, got ${seedHex}`);
  }
  const seed = seedHex.toLowerCase();
  const repairedAccent = repairContrastAgainstBg(seed);
  const accentOklch = hexToOklch(repairedAccent.hex);
  // accent-2 mirrors Nocturne: same hue, higher L, ~2/3 chroma.
  const accent2Oklch: Oklch = {
    l: Math.min(0.9, accentOklch.l + 0.075),
    c: accentOklch.c * (2 / 3),
    h: accentOklch.h,
  };
  let accent2 = oklchToHex(accent2Oklch);
  // Keep the secondary accent readable on the shell too (UI / non-text floor).
  if (contrastRatio(accent2, ACCENT_CONTRAST_BG) < ACCENT_UI_CONTRAST) {
    accent2 = repairContrastAgainstBg(accent2, ACCENT_CONTRAST_BG, ACCENT_UI_CONTRAST).hex;
  }

  const ramp = ensureChipContrast(buildRamp(accentOklch), accentOklch);
  const accent2ForRamp = hexToOklch(accent2);
  const ramp2 = ensureChipContrast(buildRamp(accent2ForRamp, 1), accent2ForRamp);

  return {
    accent: repairedAccent.hex,
    accent2,
    ramp,
    ramp2,
    repaired: repairedAccent.repaired || repairedAccent.hex !== seed,
    seed,
  };
}

/** Flat map of CSS variables → hex for inline style / setProperty. */
export function paletteToCssVars(palette: AccentPalette): Record<string, string> {
  const vars: Record<string, string> = {
    '--color-accent': palette.accent,
    '--cf-accent': palette.accent,
    '--color-accent-2': palette.accent2,
    '--cf-accent-2': palette.accent2,
  };
  for (const step of RAMP_STEPS) {
    vars[`--color-accent-${step}`] = palette.ramp[step];
    vars[`--color-accent-2-${step}`] = palette.ramp2[step];
  }
  return vars;
}

/**
 * Apply (or clear, when null) the user's personal accent as CSS custom
 * properties on `root` (defaults to documentElement).
 */
export function applyAccentColor(
  accentColor: string | null,
  root: CSSStyleDeclaration = document.documentElement.style,
): AccentPalette | null {
  if (!accentColor) {
    for (const name of ACCENT_CSS_VARS) root.removeProperty(name);
    return null;
  }
  const normalized = normalizeHex(accentColor);
  if (!normalized) {
    for (const name of ACCENT_CSS_VARS) root.removeProperty(name);
    return null;
  }
  const palette = buildAccentPalette(normalized);
  const vars = paletteToCssVars(palette);
  for (const [name, value] of Object.entries(vars)) {
    root.setProperty(name, value);
  }
  return palette;
}

/** Essential-surface contrast checks used by tests and the preferences UI. */
export function evaluateAccentSafety(palette: AccentPalette, bg: string = ACCENT_CONTRAST_BG) {
  return {
    link: contrastRatio(palette.accent, bg),
    focus: contrastRatio(palette.accent, bg),
    button: contrastRatio(palette.accent, bg),
    selected: contrastRatio(palette.ramp[300], bg),
    indicator: contrastRatio(palette.ramp[400], bg),
    chip: contrastRatio(palette.ramp[100], palette.ramp[800]),
  };
}

export function accentMeetsContrastFloors(palette: AccentPalette, bg: string = ACCENT_CONTRAST_BG): boolean {
  const s = evaluateAccentSafety(palette, bg);
  return (
    s.link >= ACCENT_TEXT_CONTRAST &&
    s.focus >= ACCENT_UI_CONTRAST &&
    s.button >= ACCENT_TEXT_CONTRAST &&
    s.selected >= ACCENT_TEXT_CONTRAST &&
    s.indicator >= ACCENT_UI_CONTRAST &&
    s.chip >= ACCENT_CHIP_CONTRAST
  );
}
