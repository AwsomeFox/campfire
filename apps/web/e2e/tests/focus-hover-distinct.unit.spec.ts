/**
 * Focus must be visually distinguishable from hover (issue #1684, split from #1533 §4).
 *
 * `.cf-page-header__menuitem` and a StatusMenuButton listbox option both suppressed the
 * canonical focus ring (`outline: none` / Tailwind `outline-none`) and substituted a tint
 * that happened to be IDENTICAL to their own `:hover` treatment — ~1.33:1 and ~1.47:1
 * respectively, against the canonical ring's 4.7:1 (`nocturne.css:144`). A keyboard user
 * genuinely could not tell "this is where I am" (focus) from "this is what my mouse is
 * over" (hover), and the page-header overflow menu is the only path to secondary actions
 * below 40rem.
 *
 * The defect is specifically that focus and hover are INDISTINGUISHABLE FROM EACH OTHER —
 * not merely that focus is faint. A fix that raises contrast on both, or that makes focus
 * visible while leaving it identical to hover, does not solve it. This suite:
 *
 *   1. Pins the two named sites to a shape where focus-visible and hover produce
 *      genuinely different declarations (not just re-checks "focus is visible").
 *   2. Sweeps every CSS rule in index.css/nocturne.css/CampaignSettingsPage.css for the
 *      general shape of the bug — a selector list that joins a `:hover` selector and a
 *      `:focus`/`:focus-visible` selector for the same base class into ONE rule (which by
 *      construction gives them identical declarations) AND explicitly suppresses the
 *      outline (`outline: none`/`outline: 0`) in that same rule. This is the precise
 *      "merged + suppressed" combination that produced both named bugs; a merged selector
 *      that does NOT suppress the outline (e.g. `.cf-term-help__trigger`, verified by hand
 *      during the #1684 audit) still gets the un-overridden canonical `:focus-visible`
 *      ring layered on top, so it is correctly excluded rather than allowlisted away.
 *   3. Sweeps TSX `className` strings for the same shape in Tailwind form: `outline-none`
 *      plus matching `hover:UTIL` / `focus-visible:UTIL` (or `focus:UTIL`) pairs using the
 *      identical utility suffix.
 *
 * Pure source scan — no browser, no server — runs under playwright.unit.config.ts.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const READ = (path: string) => readFileSync(path, 'utf8');

function collectSources(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, exts, out);
    } else if (exts.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const CSS_FILES = collectSources(ROOT, /\.css$/);
const TSX_FILES = collectSources(ROOT, /\.tsx$/);

/** One `selector-list { body }` rule, flat (does not track @media nesting — not needed here). */
interface CssRule {
  selectors: string[];
  body: string;
}

/**
 * Extract flat rule blocks from CSS text. Handles the codebase's actual shape (no CSS
 * nesting) — an `@media (...) {` wrapper line fails to match as a "rule" itself (its
 * "body" hits a nested `{` before the required `}`), so only its un-nested descendants are
 * ever returned. That's exactly what we want to scan.
 */
function extractRules(cssRaw: string): CssRule[] {
  // Strip comments first — otherwise a doc comment immediately preceding a rule gets
  // swallowed into that rule's "selector" text (no braces to stop it at).
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selectorList = m[1].trim();
    if (selectorList.startsWith('@')) continue; // @keyframes step selectors etc. — not our target
    rules.push({
      selectors: selectorList.split(',').map((s) => s.trim()),
      body: m[2],
    });
  }
  return rules;
}

/** The pseudo-class suffix a selector ends with (`:hover`, `:focus-visible`, `:focus`), or null. */
function pseudoSuffix(selector: string): 'hover' | 'focus-visible' | 'focus' | null {
  if (selector.endsWith(':hover')) return 'hover';
  if (selector.endsWith(':focus-visible')) return 'focus-visible';
  if (selector.endsWith(':focus')) return 'focus';
  return null;
}

function outlineSuppressed(body: string): boolean {
  return /outline\s*:\s*(none|0)\b/.test(body);
}

test.describe('Focus is visually distinct from hover (#1684)', () => {
  test('the two named sites keep genuinely different focus vs. hover declarations', () => {
    const indexCss = READ(join(ROOT, 'index.css'));

    // .cf-page-header__menuitem: hover gets the tint, focus-visible gets the canonical
    // ring — NOT the reverse-merged "both get the same background, outline: none" shape.
    const hoverRule = extractRules(indexCss).find(
      (r) => r.selectors.length === 1 && r.selectors[0] === '.cf-page-header__menuitem:hover',
    );
    const focusRule = extractRules(indexCss).find(
      (r) => r.selectors.length === 1 && r.selectors[0] === '.cf-page-header__menuitem:focus-visible',
    );
    expect(hoverRule, '.cf-page-header__menuitem:hover must be its own rule').toBeTruthy();
    expect(focusRule, '.cf-page-header__menuitem:focus-visible must be its own rule').toBeTruthy();
    expect(outlineSuppressed(hoverRule!.body)).toBe(false);
    expect(outlineSuppressed(focusRule!.body)).toBe(false);
    // The two bodies must differ — the actual bug was these being byte-identical.
    expect(hoverRule!.body.replace(/\s+/g, ' ').trim()).not.toBe(focusRule!.body.replace(/\s+/g, ' ').trim());
    expect(focusRule!.body).toMatch(/outline\s*:\s*2px solid var\(--color-accent\)/);

    // StatusMenuButton listbox option: same shape, Tailwind form.
    const statusMenu = READ(join(ROOT, 'components/StatusMenuButton.tsx'));
    // The className is on the line containing `w-full text-left text-xs rounded`.
    const classLine = statusMenu.split('\n').find((l) => l.includes('w-full text-left text-xs rounded'))!;
    expect(classLine, 'StatusMenuButton option className not found').toBeTruthy();
    expect(classLine).not.toMatch(/focus-visible:bg-slate-700/);
    expect(classLine).not.toMatch(/focus:bg-slate-700/);
    expect(classLine).toMatch(/hover:bg-slate-700/);
    expect(classLine).toMatch(/focus-visible:outline\b/);
    // The bug this guards: `focus-visible:outline-[2px_solid_var(--color-accent)]` compiles to
    // no CSS at all in Tailwind v4 (the outline-[...] arbitrary form only resolves to
    // outline-width or outline-color, never the shorthand), so a plain substring check on
    // `focus-visible:outline` would still pass if that broken form were reintroduced. Assert
    // the split form explicitly instead.
    expect(classLine).not.toMatch(/focus-visible:outline-\[[^\]]*\s[^\]]*\]/);
    expect(classLine).toMatch(/focus-visible:outline\s/);
    expect(classLine).toMatch(/focus-visible:outline-2\b/);
  });

  test('no CSS rule merges a :hover selector with a :focus/:focus-visible selector for the ' +
    'same base class while also suppressing the outline in that merged rule', () => {
    const offenders: string[] = [];
    for (const file of CSS_FILES) {
      const css = READ(file);
      for (const rule of extractRules(css)) {
        if (rule.selectors.length < 2) continue;
        if (!outlineSuppressed(rule.body)) continue;
        const hoverBase = rule.selectors.find((s) => pseudoSuffix(s) === 'hover');
        const focusSel = rule.selectors.find((s) => {
          const p = pseudoSuffix(s);
          return p === 'focus' || p === 'focus-visible';
        });
        if (!hoverBase || !focusSel) continue;
        const base = hoverBase.slice(0, -':hover'.length);
        const focusBase = focusSel.slice(0, -(':' + pseudoSuffix(focusSel)!).length);
        if (base === focusBase) {
          offenders.push(`${file}: "${rule.selectors.join(', ')}" — merged hover+focus with outline suppressed`);
        }
      }
    }
    expect(offenders, `issue #1684 — focus indistinguishable from hover:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('no TSX className merges outline-none with identical hover:/focus(-visible): Tailwind utilities', () => {
    const offenders: string[] = [];
    const classAttrRe = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
    for (const file of TSX_FILES) {
      const text = READ(file);
      let m: RegExpExecArray | null;
      while ((m = classAttrRe.exec(text))) {
        const cls = m[1] ?? m[2] ?? '';
        if (!/\boutline-none\b/.test(cls)) continue;
        const tokens = cls.split(/\s+/).filter(Boolean);
        const hoverUtils = new Set(tokens.filter((t) => t.startsWith('hover:')).map((t) => t.slice('hover:'.length)));
        const focusUtils = tokens
          .filter((t) => t.startsWith('focus-visible:') || (t.startsWith('focus:') && !t.startsWith('focus-within:')))
          .map((t) => (t.startsWith('focus-visible:') ? t.slice('focus-visible:'.length) : t.slice('focus:'.length)));
        for (const fu of focusUtils) {
          if (hoverUtils.has(fu)) {
            offenders.push(`${file}: outline-none + identical hover:${fu} / focus(-visible):${fu}`);
          }
        }
      }
    }
    expect(offenders, `issue #1684 — focus indistinguishable from hover (Tailwind):\n${offenders.join('\n')}`).toEqual([]);
  });
});
