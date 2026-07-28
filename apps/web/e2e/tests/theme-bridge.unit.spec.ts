/**
 * Tailwind v4 `@theme` bridge (issue #1682 / #1533 §1).
 *
 * Before this, index.css had no `@theme` block anywhere — every design token
 * lived at plain `:root`, invisible to Tailwind's utility generator, which
 * compiled `p-*`/`rounded-*`/`text-*` against ITS OWN built-in defaults
 * instead. This suite pins the narrow bridge that landed and the scope
 * decision behind it, so both stay intentional rather than drifting:
 *
 *  - `rounded-sm/md/lg`, `text-xs/sm/base` are now registered in `@theme` and
 *    resolve to this app's own tokens (verified against a live build in
 *    #1682's PR description — see that for the getComputedStyle harness this
 *    static/source-only suite can't run).
 *  - `p-*`/`m-*`/`gap-*`/… (the `--spacing-*` scale) is DELIBERATELY NOT
 *    bridged yet — quantified in #1682 at ~2,124 call sites across 152 files
 *    that would all move at once with zero golden-screenshot coverage. If a
 *    future change adds `--spacing-*` to the `@theme` block without touching
 *    this file, that is exactly the kind of quiet scope-creep this test
 *    exists to catch — update it deliberately, with a fresh count, not as a
 *    side effect.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_CSS_PATH = resolve(__dirname, '../../src/index.css');
const INDEX_CSS = readFileSync(INDEX_CSS_PATH, 'utf8');

/** The single `@theme { … }` block's body (there must be exactly one). */
function themeBlockBody(): string {
  const blocks = [...INDEX_CSS.matchAll(/@theme\s*\{/g)];
  expect(blocks, 'index.css must declare exactly one @theme block (issue #1682)').toHaveLength(1);
  const start = blocks[0].index! + blocks[0][0].length;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < INDEX_CSS.length) {
    if (INDEX_CSS[i] === '{') depth++;
    else if (INDEX_CSS[i] === '}') depth--;
    i++;
  }
  return INDEX_CSS.slice(start, i - 1);
}

/**
 * The plain `:root { … }` DESIGN-TOKEN block's body. There is an earlier,
 * unrelated `:root { color-scheme: light; }` inside the `@media print` block,
 * so anchor on `--color-bg:` — the token block's first declaration — rather
 * than the first `:root {` in the file.
 */
function rootBlockBody(): string {
  const anchor = INDEX_CSS.indexOf('--color-bg:');
  expect(anchor, 'index.css must declare the --color-bg token').toBeGreaterThanOrEqual(0);
  const idx = INDEX_CSS.lastIndexOf(':root {', anchor);
  expect(idx, 'index.css must declare its :root token block').toBeGreaterThanOrEqual(0);
  const start = idx + ':root {'.length;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < INDEX_CSS.length) {
    if (INDEX_CSS[i] === '{') depth++;
    else if (INDEX_CSS[i] === '}') depth--;
    i++;
  }
  return INDEX_CSS.slice(start, i - 1);
}

function declaredValue(body: string, property: string): string | null {
  const m = body.match(new RegExp(`(?:^|[;\\s])${property.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

const THEME = themeBlockBody();
const ROOT = rootBlockBody();

test.describe('Tailwind @theme bridge (issue #1682)', () => {
  test('the @theme block exists and comes after @import "tailwindcss"', () => {
    const importIdx = INDEX_CSS.indexOf('@import "tailwindcss"');
    const themeIdx = INDEX_CSS.indexOf('@theme {');
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(themeIdx).toBeGreaterThan(importIdx);
  });

  test('radius: @theme registers rounded-sm/md/lg with the SAME values as the :root tokens', () => {
    for (const key of ['--radius-sm', '--radius-md', '--radius-lg']) {
      const themeValue = declaredValue(THEME, key);
      const rootValue = declaredValue(ROOT, key);
      expect(themeValue, `${key} must be registered in @theme`).not.toBeNull();
      expect(rootValue, `${key} must still be declared in the :root token block`).not.toBeNull();
      expect(themeValue, `${key}: @theme and :root must stay numerically identical (issue #1682 — no scale change)`).toBe(
        rootValue,
      );
    }
  });

  test('type: @theme aliases text-xs/sm/base to the existing --type-* tokens by reference, not by duplicated literal', () => {
    expect(declaredValue(THEME, '--text-xs')).toBe('var(--type-label)');
    expect(declaredValue(THEME, '--text-sm')).toBe('var(--type-control)');
    expect(declaredValue(THEME, '--text-base')).toBe('var(--type-body)');
  });

  test('the --type-* tokens the bridge aliases still exist, and text-xs/text-sm keep their historically-coincidental values (zero visual change)', () => {
    // text-xs/text-sm happen to already equal Tailwind's own defaults (12px/14px)
    // — bridging them is a no-op visually. If a future edit changes --type-label
    // or --type-control away from those values, that IS a visual change to every
    // text-xs/text-sm call site app-wide and deserves the same scrutiny #1682
    // gave --type-body (text-base) — this assertion is the tripwire.
    expect(declaredValue(ROOT, '--type-label')).toBe('0.75rem');
    expect(declaredValue(ROOT, '--type-control')).toBe('0.875rem');
  });

  test('spacing is DELIBERATELY not yet bridged — no --spacing-* key in @theme', () => {
    // See this file's header comment and #1682's PR description: ~2,124 call
    // sites across 152 files would move by a uniform -30% at once. Do not add
    // --spacing-1/2/3/4/6/8 here without re-quantifying and updating this test
    // (and this file's header) deliberately.
    for (const key of ['--spacing-1', '--spacing-2', '--spacing-3', '--spacing-4', '--spacing-6', '--spacing-8', '--spacing']) {
      expect(declaredValue(THEME, key), `${key} must not be in @theme yet (issue #1682 — staged, not landed)`).toBeNull();
    }
  });
});
