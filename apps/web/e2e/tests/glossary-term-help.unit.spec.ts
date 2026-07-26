import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  });

  test('responsive CSS keeps touch/narrow help operable without hover', () => {
    const css = readFileSync(CSS, 'utf8');
    expect(css).toMatch(/\.cf-term-help__trigger[\s\S]*?width:\s*24px/);
    expect(css).toMatch(/\.cf-term-help__trigger[\s\S]*?height:\s*24px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*40rem\)[\s\S]*?\.cf-term-help__panel[\s\S]*?position:\s*fixed/s);
    expect(css).toMatch(/max-height:\s*calc\(100dvh - 96px\)/);
  });

  test('English and Arabic catalogs mirror every glossary term', () => {
    const en = JSON.parse(readFileSync(EN, 'utf8')) as { glossary: { terms: Record<string, unknown> } };
    const ar = JSON.parse(readFileSync(AR, 'utf8')) as { glossary: { terms: Record<string, unknown> } };
    for (const term of REQUIRED_TERMS) {
      expect(en.glossary.terms[term], `en ${term}`).toBeTruthy();
      expect(ar.glossary.terms[term], `ar ${term}`).toBeTruthy();
    }
    expect(Object.keys(ar.glossary.terms).sort()).toEqual(Object.keys(en.glossary.terms).sort());
  });
});
