import { expect, test } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitTermHelpPanel, type Rect } from '../../src/components/termHelpPosition';

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const ROOT = resolve(__dirname, '../..');
const TERM_HELP = resolve(ROOT, 'src/components/TermHelp.tsx');
const TERMS = resolve(ROOT, 'src/features/glossary/glossaryTerms.ts');
const GLOSSARY_PAGE = resolve(ROOT, 'src/features/glossary/GlossaryPage.tsx');
const LAYOUT = resolve(ROOT, 'src/app/Layout.tsx');
const NAV = resolve(ROOT, 'src/app/campaignNav.ts');
const ROUTER = resolve(ROOT, 'src/app/router.tsx');
const CSS = resolve(ROOT, 'src/index.css');
const EN = resolve(ROOT, 'src/i18n/locales/en/glossary.json');
const AR = resolve(ROOT, 'src/i18n/locales/ar/glossary.json');

const REQUIRED_TERMS = [
  'cast',
  'scribe',
  'proposals',
  'compendium',
  'sessionZero',
  'storylines',
  'coDm',
  'driver',
] as const;

test.describe('glossary term help (#518)', () => {
  test('canonical term map covers required jargon with metadata and deep links', () => {
    const source = readFileSync(TERMS, 'utf8');
    for (const term of REQUIRED_TERMS) {
      expect(source, term).toContain(`'${term}'`);
    }
    expect(source).toMatch(/labelKey:/);
    expect(source).toMatch(/definitionKey:/);
    expect(source).toMatch(/audienceKey:/);
    expect(source).toMatch(/visibilityKey:/);
    expect(source).toMatch(/phaseKey:/);
    expect(source).toMatch(/glossaryTermHref/);
    expect(source).toMatch(/\/glossary#/);
  });

  test('TermHelp is an explicit disclosure with keyboard close and visible dismissal', () => {
    const source = readFileSync(TERM_HELP, 'utf8');
    expect(source).toMatch(/useDisclosure\(/);
    expect(source).toMatch(/aria-label=\{t\('glossary\.termHelpAria'/);
    expect(source).toMatch(/data-testid=\{`term-help-trigger-\$\{termId\}`\}/);
    expect(source).toMatch(/data-testid=\{`term-help-panel-\$\{termId\}`\}/);
    expect(source).toMatch(/event\.key === 'Escape'/);
    expect(source).toMatch(/localStorage\.setItem\(termHelpStorageKey\(termId\), '1'\)/);
    expect(source).toMatch(/glossary\.dismiss/);
    expect(source).not.toMatch(/onMouseEnter|onMouseOver|onPointerEnter/);
  });

  test('glossary destination is routed and linked from help/account navigation', () => {
    expect(readFileSync(ROUTER, 'utf8')).toMatch(/path:\s*'\/glossary'/);
    expect(readFileSync(GLOSSARY_PAGE, 'utf8')).toMatch(/GLOSSARY_TERM_IDS\.map/);
    const layout = readFileSync(LAYOUT, 'utf8');
    expect(layout).toMatch(/to="\/glossary"/);
    expect(layout).toMatch(/t\('glossary\.navLabel'\)/);
    const nav = readFileSync(NAV, 'utf8');
    for (const term of ['scribe', 'proposals', 'compendium', 'sessionZero', 'storylines']) {
      expect(nav, term).toContain(`termId: '${term}'`);
    }
    // The mobile More sheet is an aria-modal overlay that outlives route
    // changes, so its TermHelp must close the sheet when it deep-links out.
    expect(layout).toMatch(/<TermHelp termId=\{item\.termId\} align="end" onNavigate=\{onNavigate\} \/>/);
  });

  test('responsive CSS keeps touch/narrow help operable without hover', () => {
    const css = readFileSync(CSS, 'utf8');
    expect(css).toMatch(/\.cf-term-help__trigger[\s\S]*?width:\s*24px/);
    expect(css).toMatch(/\.cf-term-help__trigger[\s\S]*?height:\s*24px/);
    // The panel is fixed at EVERY breakpoint, not just under a mobile media
    // query: the desktop sidebar (w-[230px], overflow-x-hidden) clips
    // absolutely-positioned children, so an absolute panel is cut off there.
    expect(css).toMatch(/\.cf-term-help__panel\s*\{[^}]*position:\s*fixed/);
    expect(css).not.toMatch(/\.cf-term-help__panel\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.cf-term-help__panel\s*\{[^}]*max-height:\s*calc\(100dvh - 96px\)/);
    expect(css).toMatch(/\.cf-term-help__panel\s*\{[^}]*overflow:\s*auto/);
  });

  test('the panel is anchored to its trigger and clamped inside the viewport', () => {
    const source = readFileSync(TERM_HELP, 'utf8');
    // Fixed positioning only escapes the sidebar clip if TermHelp actually
    // computes coordinates from the trigger rect and re-computes on reflow.
    expect(source).toMatch(/getBoundingClientRect\(\)/);
    expect(source).toMatch(/fitTermHelpPanel/);
    expect(source).toMatch(/window\.addEventListener\('resize'/);
    expect(source).toMatch(/window\.addEventListener\('scroll'[^)]*true\)/);
  });

  test('fitTermHelpPanel clamps a panel wider than its sidebar host', () => {
    // The desktop sidebar case that regressed: a 280px panel anchored to a
    // trigger near the right edge of a 230px rail must not go off-screen left.
    const trigger = rect(192, 300, 24, 24);
    const panel = rect(0, 0, 280, 180);
    const fit = fitTermHelpPanel(trigger, panel, 'end', { width: 1280, height: 720 });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.left + panel.width).toBeLessThanOrEqual(1280);
    expect(fit.top).toBeGreaterThanOrEqual(0);
    expect(fit.top + Math.min(panel.height, fit.maxHeight)).toBeLessThanOrEqual(720);

    // A trigger near the right edge is pulled back inside the viewport too.
    const edge = fitTermHelpPanel(rect(1270, 40, 24, 24), panel, 'start', {
      width: 1280,
      height: 720,
    });
    expect(edge.left + panel.width).toBeLessThanOrEqual(1280);

    // A trigger low on the page flips the panel above and still fits.
    const low = fitTermHelpPanel(rect(600, 700, 24, 24), panel, 'start', { width: 1280, height: 720 });
    expect(low.top).toBeGreaterThanOrEqual(0);
    expect(low.top + Math.min(panel.height, low.maxHeight)).toBeLessThanOrEqual(720);
  });

  test('English catalog covers every glossary term (and Arabic if present)', () => {
    const en = JSON.parse(readFileSync(EN, 'utf8')) as { glossary: { terms: Record<string, unknown> } };
    for (const term of REQUIRED_TERMS) {
      expect(en.glossary.terms[term], `en ${term}`).toBeTruthy();
    }
    if (existsSync(AR)) {
      const ar = JSON.parse(readFileSync(AR, 'utf8')) as { glossary: { terms: Record<string, unknown> } };
      for (const term of REQUIRED_TERMS) {
        expect(ar.glossary.terms[term], `ar ${term}`).toBeTruthy();
      }
      expect(Object.keys(ar.glossary.terms).sort()).toEqual(Object.keys(en.glossary.terms).sort());
    }
  });
});
