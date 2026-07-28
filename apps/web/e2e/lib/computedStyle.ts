import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

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
    };
  }).then((box) => ({ ...box, height: round2(box.height), width: round2(box.width) }));
}

/** Locates the most recently built `dist/assets/index-*.css`, newest by mtime. */
export function latestCompiledCss(distAssetsDir?: string): string {
  const dir = distAssetsDir ?? resolve(__dirname, '..', '..', 'dist', 'assets');
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
  const newest = cssFiles
    .map((f) => ({ f, mtime: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!.f;
  return readFileSync(resolve(dir, newest), 'utf8');
}

/**
 * Renders `bodyHtml` against the real compiled CSS bundle via `page.setContent` — no
 * network fetch, so the stylesheet has to be inlined rather than linked (a data/blank
 * page has no origin to resolve a relative href against). `data-theme="dark"` on `<html>`
 * matches the app shell; Campfire ships one theme only (see index.css's `@media print`
 * comment — "the app is intentionally optimized for an interactive dark UI") so there is
 * no light-theme variant to also render.
 */
export async function renderCssFixture(page: Page, bodyHtml: string, css?: string): Promise<void> {
  const compiled = css ?? latestCompiledCss();
  await page.setContent(
    `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${compiled}</style></head>` +
      `<body style="background:#111;color:#eee;">${bodyHtml}</body></html>`,
    { waitUntil: 'load' },
  );
}
