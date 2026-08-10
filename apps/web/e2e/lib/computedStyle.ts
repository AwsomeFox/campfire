import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

const FONT_EXT_MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff' };


/**
 * getComputedStyle helpers for pinning real rendered geometry (issue #1694).
 *
 * Design-token and cascade-layer bugs (Tailwind v4's unlayered-beats-layered trap,
 * `!important` overrides silently zeroing a shared floor, …) are invisible to source-text
 * inspection — you have to ask the browser what it actually computed. That technique got
 * written ad hoc, by hand, three separate times (issues #1682, #1683, #1693/#1695) before
 * landing here. Prefer this module over reinventing it a fourth time.
 *
 * Two ways to get a browser-computed value, in order of preference:
 *
 * 1. `measureBox(locator)` — measure a REAL element on an already-rendered page (a seeded
 *    app route, a component test, anything with a live `Locator`). This is the strong
 *    form: no synthetic markup to get subtly wrong, no risk of a hand-rolled fixture
 *    disagreeing with how the component is actually composed in production (see the
 *    unexplained width/wrapping artifacts hit while investigating #1695 — entirely an
 *    artifact of hand-authored fixture HTML, not a real bug). Use this whenever there is
 *    any live page you can navigate to.
 *
 * 2. `renderCssFixture(page, html)` + `measureBox` — for the rarer case where no
 *    convenient live page renders the exact class combination you need to check (an
 *    isolated CSS rule, a hypothetical class combination). Loads the real compiled
 *    Tailwind output via `page.setContent`, so the cascade-layer behavior is still the
 *    real one — just against synthetic markup instead of a real component tree. Requires
 *    `apps/web` to be freshly built (`npx vite build` or `npm run build`) — stale `dist`
 *    is the first thing to suspect if a measurement doesn't match a real dev-mode render,
 *    the same trap as `packages/schema`'s stale-dist issue.
 */

export interface ComputedBox {
  height: number;
  width: number;
  minHeight: string;
  minWidth: string;
  fontSize: string;
  lineHeight: string;
  paddingTop: string;
  paddingBottom: string;
  /** Issue #2167: margin-top/bottom, needed to pin heading/`<p>`/`.hr` --space-* margins
   * (paddingTop/paddingBottom alone can't see a margin-driven consumer). */
  marginTop: string;
  marginBottom: string;
}

/** Round to 2dp — sub-pixel rendering noise otherwise makes assertions annoyingly exact. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** getComputedStyle + getBoundingClientRect for one element, rounded for stable assertions. */
export async function measureBox(locator: Locator): Promise<ComputedBox> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      height: r.height,
      width: r.width,
      minHeight: cs.minHeight,
      minWidth: cs.minWidth,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
    };
  }).then((box) => ({ ...box, height: round2(box.height), width: round2(box.width) }));
}

/** Default location of the built web assets, shared by every helper below. */
function defaultDistAssetsDir(): string {
  return resolve(__dirname, '..', '..', 'dist', 'assets');
}

/** `dist/assets/index-*.css`'s filename, newest by mtime — shared by the two functions below. */
function newestIndexCssFilename(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(
      `No build output at ${dir} — run \`npx vite build\` (or \`npm run build\`) in apps/web ` +
        'before using renderCssFixture/latestCompiledCss.',
    );
  }
  const cssFiles = entries.filter((f) => f.startsWith('index-') && f.endsWith('.css'));
  if (cssFiles.length === 0) {
    throw new Error(`No index-*.css found in ${dir} — run \`npx vite build\` in apps/web first.`);
  }
  return cssFiles.map((f) => ({ f, mtime: statSync(resolve(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]!
    .f;
}

/** Locates the most recently built `dist/assets/index-*.css`, newest by mtime. */
export function latestCompiledCss(distAssetsDir?: string): string {
  const dir = distAssetsDir ?? defaultDistAssetsDir();
  return readFileSync(resolve(dir, newestIndexCssFilename(dir)), 'utf8');
}

/**
 * Rewrite every root-relative `url(/assets/foo.woff2)` reference the compiled CSS
 * contains (issue #1692 review, Codex) into a `data:` URI read from the same
 * `dist/assets` directory, so the fixture is genuinely self-contained. Needed
 * because `page.setContent` has no origin — a root-relative URL cannot resolve
 * against it at all (not even a failed network request is attempted), so
 * `@fontsource`'s self-hosted `@font-face` rules silently never loaded and every
 * measurement was actually against the browser's fallback font stack. This
 * mattered less than it sounds for anything already measured with this module
 * before the fix: this codebase declares every relevant `line-height` as a
 * unitless multiplier (never `normal` or a font-relative unit), so computed BOX
 * HEIGHT is arithmetic on declared numbers, not on the actual font's metrics —
 * verified by re-measuring a full sample with fonts genuinely loaded and
 * confirming identical heights. WIDTH is a different story: it's glyph-shape
 * dependent and DOES shift with the substituted font, so anything measuring a
 * width (not just height/min-height) against the old `about:blank` fixture
 * would have been measuring the wrong font's metrics.
 */
function inlineFontUrls(css: string, assetsDir: string): string {
  return css.replace(/url\(\/assets\/([^)'"]+\.(woff2?|woff))\)/g, (match, filename: string, ext: string) => {
    const mime = FONT_EXT_MIME[ext];
    if (!mime) return match;
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(assetsDir, filename));
    } catch {
      return match; // Leave unresolved rather than throw — a missing font file shouldn't break non-font measurements.
    }
    return `url(data:${mime};base64,${bytes.toString('base64')})`;
  });
}

/**
 * Renders `bodyHtml` against the real compiled CSS bundle via `page.setContent` — no
 * network fetch, so the stylesheet has to be inlined rather than linked (a data/blank
 * page has no origin to resolve a relative href against). `data-theme="dark"` on `<html>`
 * matches the app shell; Campfire ships one theme only (see index.css's `@media print`
 * comment — "the app is intentionally optimized for an interactive dark UI") so there is
 * no light-theme variant to also render.
 *
 * Font URLs are rewritten to inline `data:` URIs (see `inlineFontUrls`) and the returned
 * promise doesn't resolve until `document.fonts.ready` — `waitUntil: 'load'` alone does
 * NOT wait for `font-display: swap` fonts to finish loading, so a caller measuring
 * immediately after `page.setContent` could still race a font swap.
 */
export async function renderCssFixture(
  page: Page,
  bodyHtml: string,
  css?: string,
  distAssetsDir?: string,
): Promise<void> {
  const dir = distAssetsDir ?? defaultDistAssetsDir();
  const compiled = css ?? latestCompiledCss(dir);
  const inlined = inlineFontUrls(compiled, dir);
  const safeCss = inlined.replace(/<\/style>/gi, '<\\/style>');
  await page.setContent(
    `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${safeCss}</style></head>` +
      `<body style="background:#111;color:#eee;">${bodyHtml}</body></html>`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
}
