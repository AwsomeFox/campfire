import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  COMPENDIUM_CLEAR_FILTERS_LABEL,
  COMPENDIUM_SEARCH_ID,
  COMPENDIUM_SEARCH_LABEL,
  COMPENDIUM_TYPE_FILTER_LABEL,
} from '../../src/features/compendium/compendiumA11y';
import { seed, stateFor } from './seed';

/**
 * Issue #647 — Compendium search label + type-filter selection semantics.
 *
 * The seeded campaign has no rule system, so these specs fulfill campaign +
 * packs + search reads (same approach as nav-card-links) and assert the
 * accessible names / radiogroup behaviour on the rendered page.
 */

async function stubCompendiumBrowse(page: Page, entries: unknown[]) {
  await page.route('**/api/v1/campaigns', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch().catch(() => null);
    if (!res) return route.continue();
    const original = await res.json().catch(() => null);
    if (Array.isArray(original)) {
      await route.fulfill({
        json: original.map((c) =>
          c && typeof c === 'object' && 'id' in c ? { ...c, ruleSystem: 'e2e-compendium-a11y' } : c,
        ),
      });
    } else {
      await route.fulfill({ json: original });
    }
  });
  await page.route('**/api/v1/campaigns/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch().catch(() => null);
    if (!res) return route.continue();
    const original = await res.json().catch(() => null);
    if (original && typeof original === 'object' && 'id' in original) {
      await route.fulfill({ json: { ...original, ruleSystem: 'e2e-compendium-a11y' } });
    } else {
      await route.fulfill({ json: original });
    }
  });
  await page.route('**/api/v1/rules/packs', (route) =>
    route.fulfill({
      json: [{ id: 1, slug: 'e2e-compendium-a11y', name: 'Compendium a11y pack', version: '1' }],
    }),
  );
  await page.route('**/api/v1/rules/search**', async (route) => {
    const url = new URL(route.request().url());
    const type = url.searchParams.get('type');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    let filtered = entries as Array<{ type?: string; name?: string; summary?: string }>;
    if (type) filtered = filtered.filter((e) => e.type === type);
    if (q) {
      filtered = filtered.filter(
        (e) =>
          (e.name ?? '').toLowerCase().includes(q) || (e.summary ?? '').toLowerCase().includes(q),
      );
    }
    await route.fulfill({ json: filtered });
  });
}

const FIXTURE_ENTRIES = [
  {
    id: 6_470_001,
    slug: 'fire-bolt',
    name: 'Fire Bolt',
    type: 'spell',
    summary: 'A mote of fire',
    packSlug: 'e2e-compendium-a11y',
    body: '',
    dataJson: '',
  },
  {
    id: 6_470_002,
    slug: 'goblin',
    name: 'Goblin',
    type: 'monster',
    summary: 'A small humanoid',
    packSlug: 'e2e-compendium-a11y',
    body: '',
    dataJson: '',
  },
];

test.describe('Compendium accessibility (issue #647)', () => {
  test.use({ storageState: stateFor('dm') });

  test('labels search persistently and exposes type chips as a named single-select group', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await stubCompendiumBrowse(page, FIXTURE_ENTRIES);
    await page.goto(`/c/${campaignId}/compendium`);

    const search = page.getByRole('searchbox', { name: COMPENDIUM_SEARCH_LABEL });
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('id', COMPENDIUM_SEARCH_ID);
    await expect(page.locator(`label[for="${COMPENDIUM_SEARCH_ID}"]`)).toHaveText(
      COMPENDIUM_SEARCH_LABEL,
    );

    const filters = page.getByRole('radiogroup', { name: COMPENDIUM_TYPE_FILTER_LABEL });
    await expect(filters).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    await expect(filters.getByRole('radio', { name: 'Spells' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await filters.getByRole('radio', { name: 'Spells' }).click();
    await expect(filters.getByRole('radio', { name: 'Spells' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(filters.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('link', { name: /Fire Bolt/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Goblin/ })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBe('spell');

    // Clear filters resets both type selection and any typed query — including URL params.
    await search.fill('fire');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('fire');
    await expect(page.getByRole('button', { name: COMPENDIUM_CLEAR_FILTERS_LABEL })).toBeVisible();
    await page.getByRole('button', { name: COMPENDIUM_CLEAR_FILTERS_LABEL }).click();
    await expect(search).toHaveValue('');
    await expect(filters.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: COMPENDIUM_CLEAR_FILTERS_LABEL })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull();
    await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBeNull();

    const polite = page.locator('.sr-only[aria-live="polite"][role="status"]');
    await expect(polite).toContainText(/\d+ results?/i);
  });

  test('type chips support radiogroup keyboard selection and stay wrap-friendly on touch', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 375, height: 812 });
    await stubCompendiumBrowse(page, FIXTURE_ENTRIES);
    await page.goto(`/c/${campaignId}/compendium`);

    const filters = page.getByRole('radiogroup', { name: COMPENDIUM_TYPE_FILTER_LABEL });
    await filters.getByRole('radio', { name: 'All' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(filters.getByRole('radio', { name: 'Spells' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(filters.getByRole('radio', { name: 'Spells' })).toBeFocused();
    await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBe('spell');

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);

    const accessibilityScan = await new AxeBuilder({ page })
      .include('main')
      .analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('loads q/type from the URL and rehydrates search + type chips', async ({ page }) => {
    const { campaignId } = seed();
    await stubCompendiumBrowse(page, FIXTURE_ENTRIES);
    await page.goto(`/c/${campaignId}/compendium?q=fire&type=spell`);

    const search = page.getByRole('searchbox', { name: COMPENDIUM_SEARCH_LABEL });
    const filters = page.getByRole('radiogroup', { name: COMPENDIUM_TYPE_FILTER_LABEL });
    await expect(search).toHaveValue('fire');
    await expect(filters.getByRole('radio', { name: 'Spells' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('link', { name: /Fire Bolt/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Goblin/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: COMPENDIUM_CLEAR_FILTERS_LABEL })).toBeVisible();
  });
});
