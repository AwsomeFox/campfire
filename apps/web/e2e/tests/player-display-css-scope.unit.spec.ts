/**
 * PlayerDisplayPage's injected CSS must not leak (issue #1685, split from #1533 §5).
 *
 * `PlayerDisplayPage.tsx` renders a `<style>{SCREEN_CSS}</style>` tag for its
 * TV/cast-display presentation. A `<style>` element applies to the WHOLE document
 * regardless of where it sits in the DOM tree — nesting it inside `<main class="cf-screen">`
 * provided no scoping by itself. SCREEN_CSS used to redefine the bare, app-wide `.cf-chip`
 * and `.cf-hp` class names (also used by 23 and 2 other source files respectively, including
 * the session runner's own HP bar) with its own rules, INCLUDING three hardcoded HP-fill hex
 * colours (`#5bd18b` / `#e5c15b` / `#e5735b`) that had drifted from the token values
 * `index.css`'s `.cf-hp` actually uses (`--cf-success` / `--color-accent` / `--cf-danger`) —
 * so the identical HP bar rendered a different colour on the TV display than in the session
 * runner, and while the Player Display route was mounted, every OTHER `.cf-chip`/`.cf-hp` on
 * the page (present now or added later, e.g. a global toast/banner) was silently reskinned.
 *
 * Fix, two parts:
 * 1. Colours: replaced the hardcoded hex with the same tokens `index.css`'s `.cf-hp` uses.
 *    The larger cqh/cqw sizing for the across-the-room TV surface is kept — deliberate, and
 *    expressed as a same-token override, not deleted and not left as hardcoded hex.
 * 2. Scoping: renaming the two colliding families to `cf-screen-chip*`/`cf-screen-hp*` closes
 *    today's known collisions, but a bare, un-anchored selector for a name that DOESN'T
 *    currently collide with anything (e.g. `.cf-init`, `.cf-cond`) still applies document-wide
 *    and would silently reskin any future element sharing that name — renaming is closing one
 *    hole, not scoping the pipe. So every selector in SCREEN_CSS (other than the
 *    `.cf-screen`/`.cf-screen.centered` root rule itself and the portalled
 *    `.cf-exit-pin*` family) is now ALSO prefixed with the `.cf-screen ` ancestor — the
 *    actual `<main>` this stylesheet renders inside — which confines those rules to this
 *    subtree regardless of naming. This is real, load-bearing scoping (a plain descendant
 *    combinator, universally supported — deliberately not `@scope`, since this is a TV/cast
 *    surface plausibly reached by more unusual browser environments than the rest of the
 *    app), not merely an absence-of-collision argument.
 *
 *    Portal exception: `CastExitPinDialog` renders `.cf-exit-pin` into `document.body` via
 *    `createPortal`, so those rules must stay bare (unique page-local names) to match.
 *
 * This suite makes BOTH halves structural rather than a one-off spot-check:
 * - Test 1 asserts every selector's leftmost simple selector is either the `.cf-screen`
 *   scope root or an allowed `.cf-exit-pin*` portal exception — this is the primary
 *   guarantee the issue's "does not leak outside its route" criterion asks for.
 * - Test 1 also keeps a collision backstop (no class name SCREEN_CSS uses, including
 *   `cf-screen` / `cf-exit-pin*`, collides with a name index.css/nocturne.css defines or
 *   another .tsx file uses) — a second, independent line of defence in case ancestor-scoping
 *   is ever accidentally dropped from a new rule.
 *
 * Pure source scan — no browser, no server — runs under the playwright.unit.config.ts
 * config that `npm run test:unit` and CI invoke.
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
  test('every SCREEN_CSS rule is ancestor-scoped under .cf-screen — only allowlisted bare leftmost selectors', () => {
    const pageSource = READ(PAGE_PATH);
    const screenCss = extractScreenCss(pageSource);
    const screenClassNames = bareLeftmostClassNames(screenCss);

    // Allowlisted bare leftmost selectors:
    // - `.cf-screen` / `.cf-screen.centered`: the scope root on <main>
    // - `.cf-exit-pin*`: CastExitPinDialog is createPortal'd to document.body, so these
    //   unique page-local rules must match outside the .cf-screen subtree
    // Every other rule's leftmost simple selector must be `.cf-screen` (as the ancestor of a
    // descendant combinator, e.g. `.cf-screen .cf-init { }`).
    const allowedBare = [
      'cf-exit-pin',
      'cf-exit-pin-actions',
      'cf-exit-pin-error',
      'cf-screen',
    ];
    expect(
      [...screenClassNames].sort(),
      'issue #1685 — every SCREEN_CSS rule must be scoped under the .cf-screen ancestor ' +
        '(or be an allowlisted portal exception); a bare selector here applies document-wide ' +
        'for as long as the Player Display route is mounted, whether or not the name happens ' +
        'to collide with anything today',
    ).toEqual(allowedBare);

    // Backstop: allowlisted bare names must not collide with anything defined/used elsewhere
    // in the app — independent of the scoping check above.
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
      `these class names also exist elsewhere and would be silently reskinned if ancestor-` +
        `scoping were ever removed:\n${collisions.join(', ')}`,
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
    // scoped to just these rules (not the whole file) so this stays precise about which
    // colours the issue is actually about.
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

  test('no dead --color-danger hex fallback (it is an unconditional :root token, never runtime-optional)', () => {
    const screenCss = extractScreenCss(READ(PAGE_PATH));
    expect(screenCss).not.toMatch(/var\(--color-danger\s*,/);
  });
});
