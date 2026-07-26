import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  COMPENDIUM_CLEAR_FILTERS_LABEL,
  COMPENDIUM_LOAD_MORE_LABEL,
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

type StubEntry = { type?: string; name?: string; summary?: string };

/** Default facet labels the server returns for a pack with no source-native overrides. */
const STUB_FACET_LABELS: Record<string, string> = {
  spell: 'Spells',
  monster: 'Monsters',
  hazard: 'Hazards',
  item: 'Items',
  condition: 'Conditions',
  class: 'Classes',
  race: 'Races',
  feat: 'Feats',
  section: 'Rules',
  other: 'Reference',
};
const STUB_FACET_ORDER = Object.keys(STUB_FACET_LABELS);

function matchesQuery(e: StubEntry, q: string): boolean {
  if (!q) return true;
  return (
    (e.name ?? '').toLowerCase().includes(q) || (e.summary ?? '').toLowerCase().includes(q)
  );
}

/**
 * Mirrors the server's facet contract (issue #544): the facet SET is every type the
 * active pack actually contains (absent categories are omitted), and each COUNT is the
 * query-scoped match total computed BEFORE the active type filter — so a category with
 * no match for the current query is still offered, with count 0.
 */
function stubFacets(entries: StubEntry[], q: string) {
  return STUB_FACET_ORDER.filter((type) => entries.some((e) => e.type === type)).map((type) => ({
    type,
    label: STUB_FACET_LABELS[type],
    count: entries.filter((e) => e.type === type && matchesQuery(e, q)).length,
  }));
}

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
    const all = entries as StubEntry[];
    let filtered = all;
    if (type) filtered = filtered.filter((e) => e.type === type);
    if (q) filtered = filtered.filter((e) => matchesQuery(e, q));
    // Issue #613: search returns a page object, not a bare array.
    // Issue #544: it also carries the live type facets the chip row is built from.
    await route.fulfill({
      json: {
        items: filtered,
        total: filtered.length,
        hasMore: false,
        limit: 50,
        facets: stubFacets(all, q),
      },
    });
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
  // Issue #544: prose `section` / `other` entries must surface as Rules / Reference
  // chips instead of being buried in All.
  {
    id: 6_470_003,
    slug: 'resting',
    name: 'Resting',
    type: 'section',
    summary: 'A prose rules chapter',
    packSlug: 'e2e-compendium-a11y',
    body: '',
    dataJson: '',
  },
  {
    id: 6_470_004,
    slug: 'bibliography',
    name: 'Bibliography',
    type: 'other',
    summary: 'Source-native reference material',
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

    // Issue #544: chips are derived from the active pack's live entries. Prose
    // `section`/`other` surface as Rules/Reference, every chip carries its live count,
    // and categories the pack has no entries for are not offered at all.
    await expect(filters.getByRole('radio', { name: 'All (4)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Spells (1)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Monsters (1)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Rules (1)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Reference (1)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Classes' })).toHaveCount(0);
    await expect(filters.getByRole('radio', { name: 'Races' })).toHaveCount(0);
    await expect(filters.getByRole('radio', { name: 'Conditions' })).toHaveCount(0);

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
    // Counts follow the query, but the chip SET follows the pack: a category the query
    // matches nothing in stays offered at count 0 so the user can pivot mid-search
    // instead of the chip vanishing under them (issue #544).
    await expect(filters.getByRole('radio', { name: 'Spells (1)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Monsters (0)' })).toBeVisible();
    await expect(filters.getByRole('radio', { name: 'Rules (0)' })).toBeVisible();
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
    // Chips are derived from the server's facets (issue #544), so the row hydrates a
    // tick after "All". Wait for it before driving roving tabindex from the keyboard —
    // arrowing a one-chip row is a legitimate no-op, not the behaviour under test.
    await expect(filters.getByRole('radio', { name: 'Spells (1)' })).toBeVisible();
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

  test('search failure shows an alert and does not announce empty results', async ({ page }) => {
    const { campaignId } = seed();
    await stubCompendiumBrowse(page, FIXTURE_ENTRIES);
    await page.route('**/api/v1/rules/search**', (route) =>
      route.fulfill({ status: 503, json: { message: "Couldn't search the compendium." } }),
    );
    await page.goto(`/c/${campaignId}/compendium`);

    const alert = page.getByRole('alert').filter({ hasText: /couldn't search the compendium/i });
    await expect(alert).toBeVisible();
    await expect(page.getByText(/nothing matches|no entries in this rule system/i)).toHaveCount(0);

    const polite = page.locator('.sr-only[aria-live="polite"][role="status"]');
    await expect(polite).toHaveText('');
  });

  test('clear filters searches immediately (no debounce lag) and moves focus to search', async ({
    page,
  }) => {
    const { campaignId } = seed();
    const searchFetches: Array<string | null> = [];
    await stubCompendiumBrowse(page, FIXTURE_ENTRIES);
    // Register after stubCompendiumBrowse so this handler wins (Playwright LIFO).
    await page.route('**/api/v1/rules/search**', async (route) => {
      const url = new URL(route.request().url());
      searchFetches.push(url.searchParams.get('q'));
      const type = url.searchParams.get('type');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      let filtered = FIXTURE_ENTRIES as StubEntry[];
      if (type) filtered = filtered.filter((e) => e.type === type);
      if (q) filtered = filtered.filter((e) => matchesQuery(e, q));
      await route.fulfill({
        json: {
          items: filtered,
          total: filtered.length,
          hasMore: false,
          limit: 50,
          facets: stubFacets(FIXTURE_ENTRIES as StubEntry[], q),
        },
      });
    });

    await page.goto(`/c/${campaignId}/compendium`);
    const search = page.getByRole('searchbox', { name: COMPENDIUM_SEARCH_LABEL });
    await search.fill('fire');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('fire');
    await expect(page.getByRole('link', { name: /Fire Bolt/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Goblin/ })).toHaveCount(0);

    const clearBtn = page.getByRole('button', { name: COMPENDIUM_CLEAR_FILTERS_LABEL });
    await clearBtn.focus();
    await expect(clearBtn).toBeFocused();
    const priorFetchCount = searchFetches.length;
    await clearBtn.click();

    // Focus must land on a stable control — the clear button unmounts.
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull();

    // First post-clear fetch must use empty q immediately (not the prior term for ~300ms).
    await expect.poll(() => searchFetches.length).toBeGreaterThan(priorFetchCount);
    expect(searchFetches[priorFetchCount]).toBeNull();
    await expect(page.getByRole('link', { name: /Goblin/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Fire Bolt/ })).toBeVisible();
  });

  test('load more appends the next page and shows truncation counts (issue #613)', async ({ page }) => {
    const { campaignId } = seed();
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: 6_130_000 + i,
      slug: `entry-${i}`,
      name: `Entry ${String(i).padStart(2, '0')}`,
      type: 'spell',
      summary: `Summary ${i}`,
      packSlug: 'e2e-compendium-a11y',
      body: '',
      dataJson: '',
    }));
    const page2 = [
      {
        id: 6_130_050,
        slug: 'entry-50',
        name: 'Entry 50',
        type: 'spell',
        summary: 'Summary 50',
        packSlug: 'e2e-compendium-a11y',
        body: '',
        dataJson: '',
      },
    ];

    await stubCompendiumBrowse(page, page1);
    await page.route('**/api/v1/rules/search**', async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get('cursor');
      const facets = [{ type: 'spell', label: 'Spells', count: 51 }];
      if (!cursor) {
        await route.fulfill({
          json: {
            items: page1,
            total: 51,
            hasMore: true,
            nextCursor: 'cursor-page-2',
            limit: 50,
            facets,
          },
        });
        return;
      }
      await route.fulfill({
        json: { items: page2, total: 51, hasMore: false, limit: 50, facets },
      });
    });

    await page.goto(`/c/${campaignId}/compendium`);
    await expect(page.getByText('Showing 50 of 51', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Entry 00/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Entry 50/ })).toHaveCount(0);

    await page.getByRole('button', { name: COMPENDIUM_LOAD_MORE_LABEL }).click();
    await expect(page.getByRole('link', { name: /Entry 50/ })).toBeVisible();
    await expect(page.getByRole('button', { name: COMPENDIUM_LOAD_MORE_LABEL })).toHaveCount(0);
    await expect(page.getByText(/^51 results$/i)).toBeVisible();
  });
});
