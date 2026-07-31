/**
 * Responsive PageHeader source contracts (issue #707).
 *
 * Pins the shared CSS + component + call-site wiring so crowded list headers
 * cannot quietly regress to compact `!min-h-0` rows that break the 44px
 * touch-target floor. Pure unit — no browser, no seeded backend.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const INDEX_CSS = resolve(ROOT, 'src/index.css');
const PAGE_HEADER = resolve(ROOT, 'src/components/PageHeader.tsx');
const COMMON_I18N = resolve(ROOT, 'src/i18n/locales/en/common.json');

const MIGRATED_PAGES = [
  'src/features/locations/LocationListPage.tsx',
  'src/features/npcs/NpcListPage.tsx',
  'src/features/factions/FactionListPage.tsx',
  'src/features/characters/PartyPage.tsx',
  'src/features/sessions/SessionsPage.tsx',
  'src/features/encounters/EncounterListPage.tsx',
  'src/features/inventory/InventoryPage.tsx',
] as const;

test.describe('PageHeader source contracts (issue #707)', () => {
  test('CSS stacks below 40rem, keeps 44px actions, and exposes overflow/inline slots', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.cf-page-header\s*\{/);
    expect(css).toMatch(/\.cf-page-header__action[\s\S]*?min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-page-header__overflow-trigger[\s\S]*?min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-page-header__menuitem[\s\S]*?min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-page-header__secondary-inline\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/@media\s*\(min-width:\s*40rem\)[\s\S]*?\.cf-page-header__secondary-inline[\s\S]*?display:\s*inline-flex/s);
    expect(css).toMatch(/@media\s*\(min-width:\s*40rem\)[\s\S]*?\.cf-page-header__overflow[\s\S]*?display:\s*none/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*39\.99rem\)[\s\S]*?flex-direction:\s*column/s);
    expect(css).toMatch(/env\(safe-area-inset-left/);
    expect(css).toMatch(/env\(safe-area-inset-right/);
  });

  test('PageHeader title uses canonical display typeface and weight tokens (issue #1714)', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.cf-page-header__title\s*\{[\s\S]*?font-family:\s*var\(--font-display\)/s);
    expect(css).toMatch(/\.cf-page-header__title\s*\{[\s\S]*?font-weight:\s*var\(--font-display-weight\)/s);
    expect(css).toMatch(/\.cf-page-header__title\s*\{[\s\S]*?letter-spacing:\s*-0\.02em/s);
    expect(css).toMatch(/\.cf-page-header--card\s+\.cf-page-header__title\s*\{[\s\S]*?font-weight:\s*var\(--font-display-weight\)/s);
  });

  test('PageHeader exposes title, primary, and secondary/overflow slots', () => {
    const source = readFileSync(PAGE_HEADER, 'utf8');
    expect(source).toMatch(/export function PageHeader/);
    expect(source).toMatch(/primaryAction\?:/);
    expect(source).toMatch(/secondaryActions\?:/);
    expect(source).toMatch(/data-testid="page-header"/);
    expect(source).toMatch(/data-testid="page-header-overflow"/);
    expect(source).toMatch(/data-testid="page-header-primary"/);
    expect(source).toMatch(/aria-haspopup="menu"/);
    expect(source).toMatch(/role="menu"/);
    expect(source).toMatch(/role="menuitem"/);
    // Must not reintroduce the compact override that broke tap targets on controls.
    expect(source).not.toMatch(/className=\{?['"`][^'"`]*!min-h-0/);
    expect(source).not.toMatch(/className=\{`[^`]*!min-h-0/);
  });

  test('i18n labels cover the overflow trigger and menu', () => {
    const common = JSON.parse(readFileSync(COMMON_I18N, 'utf8')) as {
      common: Record<string, string>;
    };
    expect(common.common.moreActions).toBe('More actions');
    expect(common.common.pageActionsMenu).toBe('Page actions');
  });

  test('crowded list hubs import PageHeader and drop compact header CTAs', () => {
    for (const rel of MIGRATED_PAGES) {
      const source = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(source, rel).toMatch(/from ['"].*PageHeader['"]/);
      expect(source, rel).toMatch(/<PageHeader[\s>]/);
      // Header primary actions must not use the old compact shrink classes.
      // Inline create-form Cancel/Create buttons may still be compact — only
      // flag the PageHeader primaryAction block.
      const primaryBlock = source.match(
        /primaryAction=\{\s*[\s\S]*?<Btn[\s\S]*?<\/Btn>\s*[\s\S]*?\}/,
      );
      if (primaryBlock) {
        expect(primaryBlock[0], rel).not.toMatch(/!min-h-0/);
      }
    }
  });
});
