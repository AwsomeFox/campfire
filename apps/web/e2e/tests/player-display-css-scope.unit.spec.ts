/**
 * PlayerDisplayPage's injected CSS must not leak (issue #1685, split from #1533 §5).
 *
 * `PlayerDisplayPage.tsx` renders a `<style>{SCREEN_CSS}</style>` tag for its
 * TV/cast-display presentation. A `<style>` element applies to the WHOLE document
 * regardless of where it sits in the DOM tree — nesting it inside `<main class="cf-screen">`
 * provides no real scoping. SCREEN_CSS used to redefine the bare, app-wide `.cf-chip` and
 * `.cf-hp` class names (also used by 23 and 2 other source files respectively, including the
 * session runner's own HP bar) with its own rules, INCLUDING three hardcoded HP-fill hex
 * colours (`#5bd18b` / `#e5c15b` / `#e5735b`) that had drifted from the token values
 * `index.css`'s `.cf-hp` actually uses (`--cf-success` / `--color-accent` / `--cf-danger`) —
 * so the identical HP bar rendered a different colour on the TV display than in the session
 * runner, and while the Player Display route was mounted, every OTHER `.cf-chip`/`.cf-hp` on
 * the page (present now or added later, e.g. a global toast/banner) was silently reskinned.
 *
 * Fix: renamed the colliding class families to `cf-screen-chip*` / `cf-screen-hp*` (matching
 * every other selector in this stylesheet, which was already uniquely prefixed) and replaced
 * the hardcoded hex with the same tokens `index.css`'s `.cf-hp` uses. The larger cqh/cqw sizing
 * for the across-the-room TV surface is kept — deliberate, and expressed as a same-token
 * override under a collision-proof name, not deleted and not left as hardcoded hex.
 *
 * This suite makes the "cannot leak" guarantee structural rather than a one-off spot-check:
 * it extracts every class name SCREEN_CSS actually selects and asserts NONE of them are also
 * defined by index.css/nocturne.css or used by any OTHER .tsx file in the app — exhaustive,
 * not a fixed allowlist, so a future contributor reusing a common name is caught immediately.
 *
 * Pure source scan — no browser, no server — runs under playwright.unit.config.ts (the
 * config `npm run test:unit` / CI actually invoke; NOT pw-unit.config.ts, which is currently
 * wired into no script — see issue #1532).
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const PAGE_PATH = join(ROOT, 'features/screen/PlayerDisplayPage.tsx');
const READ = (p: string) => readFileSync(p, 'utf8');

function collectFiles(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, exts, out);
    } else if (exts.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Pull the SCREEN_CSS template literal's raw contents out of the page source. */
function extractScreenCss(pageSource: string): string {
  const m = pageSource.match(/const SCREEN_CSS = `([\s\S]*?)`;\s*$/m);
  if (!m) throw new Error('SCREEN_CSS template literal not found in PlayerDisplayPage.tsx — did it move or get renamed?');
  return m[1];
}

/** Every class name any selector in this CSS text matches against (any position, any compound). */
function cssSelectorClassNames(cssRaw: string): Set<string> {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set<string>();
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selectorList = m[1].trim();
    if (selectorList.startsWith('@')) continue;
    for (const token of selectorList.match(/\.[a-zA-Z0-9_-]+/g) ?? []) {
      names.add(token.slice(1));
    }
  }
  return names;
}

/**
 * Class names that are the SOLE, un-compounded, un-qualified class of the leftmost simple
 * selector in some selector branch — e.g. `.cf-hp { }` or `.cf-hp > div { }` (leftmost segment
 * `.cf-hp`), but NOT `.cf-hp.low { }` (compounded — the element must carry BOTH classes, so it
 * is already anchored) and NOT `.cf-cockpit .btn { }` (descendant of another compound — can
 * only match a `.btn` that is already inside `.cf-cockpit`).
 *
 * This is precisely the shape of the actual #1685 bug: `.cf-chip { }` / `.cf-chip-sm { }` /
 * `.cf-chip-accent { }` / `.cf-hp { }` / `.cf-hp > div { }` were each a bare, unqualified,
 * un-anchored class selector — matching ANY element in the whole document with that class,
 * not merely one that also happens to live under this component. A compound or descendant
 * selector built on a class that is ITSELF confirmed page-local (e.g. `.cf-screen-hp.low`,
 * `.cf-cockpit .btn`) cannot leak, because it can never match anything lacking that anchor.
 */
function bareLeftmostClassNames(cssRaw: string): Set<string> {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set<string>();
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selectorList = m[1].trim();
    if (selectorList.startsWith('@')) continue;
    for (const branch of selectorList.split(',')) {
      const trimmed = branch.trim();
      const leftmost = (trimmed.match(/^[^\s>+~]+/) ?? [trimmed])[0];
      const bare = leftmost.match(/^\.([a-zA-Z0-9_-]+)$/);
      if (bare) names.add(bare[1]);
    }
  }
  return names;
}

/** Every class-name token referenced by a `className="…"` / `className={\`…\`}` in TSX text. */
function tsxClassNameTokens(text: string): Set<string> {
  const names = new Set<string>();
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    for (const tok of raw.split(/[\s${}]+/)) {
      if (/^[a-zA-Z0-9_-]+$/.test(tok)) names.add(tok);
    }
  }
  return names;
}

const CSS_FILES = collectFiles(ROOT, /\.css$/);
const TSX_FILES = collectFiles(ROOT, /\.tsx$/).filter((f) => f !== PAGE_PATH);

test.describe('PlayerDisplayPage injected CSS does not leak (#1685)', () => {
  test('SCREEN_CSS has no bare, un-anchored selector for a class name used elsewhere in the app', () => {
    const pageSource = READ(PAGE_PATH);
    const screenCss = extractScreenCss(pageSource);
    const screenClassNames = bareLeftmostClassNames(screenCss);
    expect(screenClassNames.size, 'SCREEN_CSS should select a non-trivial number of bare top-level classes').toBeGreaterThan(20);

    const externalNames = new Set<string>();
    for (const file of CSS_FILES) {
      for (const n of cssSelectorClassNames(READ(file))) externalNames.add(n);
    }
    for (const file of TSX_FILES) {
      for (const n of tsxClassNameTokens(READ(file))) externalNames.add(n);
    }

    const collisions = [...screenClassNames].filter((n) => externalNames.has(n)).sort();
    expect(
      collisions,
      `issue #1685 — PlayerDisplayPage's <style> tag is unscoped (a <style> element applies ` +
        `document-wide); these class names also exist elsewhere and would be silently ` +
        `reskinned for as long as the Player Display route is mounted:\n${collisions.join(', ')}`,
    ).toEqual([]);
  });

  test('the two named collision sites specifically no longer exist', () => {
    const screenCss = extractScreenCss(READ(PAGE_PATH));
    const names = cssSelectorClassNames(screenCss);
    expect(names.has('cf-chip')).toBe(false);
    expect(names.has('cf-chip-sm')).toBe(false);
    expect(names.has('cf-chip-accent')).toBe(false);
    expect(names.has('cf-hp')).toBe(false);
    expect(names.has('cf-screen-chip')).toBe(true);
    expect(names.has('cf-screen-hp')).toBe(true);
  });

  test('the JSX itself no longer references the old colliding class names', () => {
    const pageSource = READ(PAGE_PATH);
    // Anchored to className attribute values (not e.g. this file's own explanatory prose),
    // same anchoring discipline as other source-scanning tests in this suite.
    const tokens = tsxClassNameTokens(pageSource);
    expect(tokens.has('cf-chip')).toBe(false);
    expect(tokens.has('cf-chip-sm')).toBe(false);
    expect(tokens.has('cf-chip-accent')).toBe(false);
    expect(tokens.has('cf-hp')).toBe(false);
  });

  test('HP fill colours use the same tokens as index.css .cf-hp, not hardcoded hex', () => {
    const screenCss = extractScreenCss(READ(PAGE_PATH));
    // Pin the three specific rule bodies to a token reference with no hex literal in them —
    // scoped to just these rules (not the whole file) since other, unrelated pre-existing
    // `var(--color-danger, #e5735b)` inline fallbacks elsewhere in this stylesheet are out of
    // this issue's scope and coincidentally reuse one of the same digits.
    const hpDefaultRule = screenCss.match(/\.cf-screen-hp\s*>\s*div\s*\{([^}]*)\}/)?.[1] ?? '';
    const hpLowRule = screenCss.match(/\.cf-screen-hp\.low\s*>\s*div\s*\{([^}]*)\}/)?.[1] ?? '';
    const hpCritRule = screenCss.match(/\.cf-screen-hp\.crit\s*>\s*div\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(hpDefaultRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(hpLowRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(hpCritRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(screenCss).toMatch(/\.cf-screen-hp\s*>\s*div\s*\{[^}]*background:\s*var\(--cf-success\)/);
    expect(screenCss).toMatch(/\.cf-screen-hp\.low\s*>\s*div\s*\{[^}]*background:\s*var\(--color-accent\)/);
    expect(screenCss).toMatch(/\.cf-screen-hp\.crit\s*>\s*div\s*\{[^}]*background:\s*var\(--cf-danger\)/);

    // And these must be the SAME tokens index.css's own .cf-hp uses, so the two surfaces
    // are structurally incapable of disagreeing again.
    const indexCss = READ(join(ROOT, 'index.css'));
    const appHpRule = indexCss.match(/\.cf-hp\s*>\s*div\s*\{([^}]*)\}/);
    const appHpLow = indexCss.match(/\.cf-hp\.low\s*>\s*div\s*\{([^}]*)\}/);
    const appHpCrit = indexCss.match(/\.cf-hp\.crit\s*>\s*div\s*\{([^}]*)\}/);
    expect(appHpRule?.[1]).toMatch(/var\(--cf-success\)/);
    expect(appHpLow?.[1]).toMatch(/var\(--color-accent\)/);
    expect(appHpCrit?.[1]).toMatch(/var\(--cf-danger\)/);
  });
});
