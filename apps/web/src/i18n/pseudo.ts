/**
 * Pseudo-localization catalog (issue #629).
 *
 * Expands English strings with accent marks and brackets so missing translations
 * and layout regressions are obvious during development — without shipping a
 * separate translator-maintained catalog.
 */

const ACCENT_MAP: Record<string, string> = {
  a: 'á',
  A: 'Á',
  b: 'ḃ',
  B: 'Ḃ',
  c: 'ć',
  C: 'Ć',
  d: 'ḋ',
  D: 'Ḋ',
  e: 'é',
  E: 'É',
  f: 'ḟ',
  F: 'Ḟ',
  g: 'ġ',
  G: 'Ġ',
  h: 'ḣ',
  H: 'Ḣ',
  i: 'í',
  I: 'Í',
  j: 'ĵ',
  J: 'Ĵ',
  k: 'ḱ',
  K: 'Ḱ',
  l: 'ŀ',
  L: 'Ŀ',
  m: 'ḿ',
  M: 'Ḿ',
  n: 'ń',
  N: 'Ń',
  o: 'ó',
  O: 'Ó',
  p: 'ṕ',
  P: 'Ṕ',
  q: 'q̇',
  Q: 'Q̇',
  r: 'ŕ',
  R: 'Ŕ',
  s: 'ś',
  S: 'Ś',
  t: 'ṫ',
  T: 'Ṫ',
  u: 'ú',
  U: 'Ú',
  v: 'ṽ',
  V: 'Ṽ',
  w: 'ẃ',
  W: 'Ẃ',
  x: 'ẋ',
  X: 'Ẋ',
  y: 'ý',
  Y: 'Ý',
  z: 'ź',
  Z: 'Ź',
};

/** Preserve i18next interpolation tokens (`{{name}}`, `{{count}}`, …). */
const INTERPOLATION_RE = /\{\{[^}]+\}\}/g;

function accentize(segment: string): string {
  return [...segment].map((ch) => ACCENT_MAP[ch] ?? ch).join('');
}

export function pseudoLocalizeString(value: string): string {
  if (!value || value.startsWith('_')) return value;
  const parts = value.split(INTERPOLATION_RE);
  const tokens = value.match(INTERPOLATION_RE) ?? [];
  let out = '';
  for (let i = 0; i < parts.length; i += 1) {
    out += accentize(parts[i] ?? '');
    if (i < tokens.length) out += tokens[i];
  }
  return `⟦${out}⟧`;
}

export function pseudoLocalizeCatalog(catalog: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(catalog)) {
    if (key.startsWith('_')) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = pseudoLocalizeCatalog(value as Record<string, unknown>);
    } else if (typeof value === 'string') {
      out[key] = pseudoLocalizeString(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
