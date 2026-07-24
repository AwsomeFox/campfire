import { test, expect, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Navigation cards must be real anchors (issue #708).
 *
 * Buttons and `preventDefault`-ed anchors cancel native browser behavior:
 * modifier-click (cmd/ctrl to open a tab), middle-click, the context menu's
 * "copy link", the status-bar destination preview, and screen-reader link
 * announcements all disappear. Each navigation-only card should render as a
 * React Router `<Link>` (an `<a>` with the correct `href`) so the platform
 * behaviors come for free.
 *
 * We assert the invariants that survive headless Playwright (no real "open in
 * new tab"): the element is an anchor with the correct href, it is in the tab
 * order (focusable as a link), and a modifier-click does NOT run the SPA's
 * in-page navigation (the browser would have intercepted it). We also click
 * through to confirm the destination URL still resolves for an unmodified click.
 */

const MODIFIER = process.platform === 'darwin' ? ('Meta' as const) : ('Control' as const);

async function assertNativeAnchor(page: Page, locator: Locator, expectedHref: string) {
  await expect(locator).toBeVisible();
  // nodeName === 'A' proves a real anchor (not a <button> or <div onClick>).
  const nodeName = await locator.evaluate((el) => el.nodeName);
  expect(nodeName).toBe('A');
  // The href must carry the destination path — copy-link and the status bar
  // both read this attribute.
  await expect(locator).toHaveAttribute('href', expectedHref);
  // Keyboard reachability: focusing the link puts it in the tab order as an
  // anchor. A button styled as a link (or a div with onClick) would not focus
  // as nodeName 'A'.
  await locator.focus();
  const focused = await page.evaluate(() => document.activeElement?.nodeName);
  expect(focused).toBe('A');
}

test.describe('navigation cards are native anchors', () => {
  test.use({ storageState: stateFor('dm') });

  test('campaign tile on the home hub is a focusable anchor with the right href', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto('/');
    // The seeded campaign "E2E — Cinderhaven" is the DM's, so it appears as an
    // active campaign tile.
    const card = page.locator(`a[href="/c/${campaignId}"]`).first();
    await assertNativeAnchor(page, card, `/c/${campaignId}`);
    // Plain click navigates in-place.
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}$`));
  });

  test('cmd/ctrl-click on a campaign tile is left to the browser', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto('/');
    const card = page.locator(`a[href="/c/${campaignId}"]`).first();
    await expect(card).toBeVisible();
    // A modifier-click is the browser's "open in new tab" gesture. In a real
    // browser the SPA hands it to the platform and does NOT run client-side
    // navigation. We assert the URL stays on the hub — proving React Router
    // honored the modifier instead of forcing an in-app route change. The old
    // <button> path could not satisfy this at all; a prevented <a> actively
    // broke it.
    await card.click({ modifiers: [MODIFIER] });
    await expect(page).toHaveURL(/\/$/);
  });

  test('NPC roster card is a focusable anchor with the right href', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/npcs`);
    const href = `/c/${campaignId}/npcs/${navigation.npcId}`;
    const card = page.locator(`a[href="${href}"]`).first();
    await assertNativeAnchor(page, card, href);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('location roster card is a focusable anchor with the right href', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/locations`);
    const href = `/c/${campaignId}/locations/${navigation.locationId}`;
    const card = page.locator(`a[href="${href}"]`).first();
    await assertNativeAnchor(page, card, href);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('faction roster card is a focusable anchor with the right href', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/factions`);
    const href = `/c/${campaignId}/factions/${navigation.factionId}`;
    const card = page.locator(`a[href="${href}"]`).first();
    await assertNativeAnchor(page, card, href);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('compendium result row is a focusable anchor with the right href', async ({ page }) => {
    const { campaignId } = seed();
    // The seeded campaign has no rule system chosen, so the compendium would
    // normally sit in its empty state. The card under test only renders when
    // results are present, so fulfill the campaign + search reads with a
    // synthetic entry — the rendered <Link> is what we care about, not the
    // data. (A real install/rule-system flow is exercised by the statblock
    // fixtures in other specs.)
    const entryId = 4_070_008;
    const entry = {
      id: entryId,
      slug: 'navcard-link-fixture',
      name: 'NavCard Link Fixture',
      type: 'monster',
      summary: 'Navigation card fixture',
      packSlug: 'e2e-navcard',
      body: '',
      dataJson: '',
    };
    await page.route('**/api/v1/campaigns', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch().catch(() => null);
      if (!res) return route.continue();
      const original = await res.json().catch(() => null);
      if (Array.isArray(original)) {
        await route.fulfill({
          json: original.map((c) => (c && typeof c === 'object' && 'id' in c ? { ...c, ruleSystem: 'e2e-navcard' } : c)),
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
        await route.fulfill({ json: { ...original, ruleSystem: 'e2e-navcard' } });
      } else {
        await route.fulfill({ json: original });
      }
    });
    await page.route('**/api/v1/rules/packs', (route) =>
      route.fulfill({ json: [{ id: 1, slug: 'e2e-navcard', name: 'NavCard pack', version: '1' }] }),
    );
    await page.route('**/api/v1/rules/search**', (route) =>
      route.fulfill({ json: { items: [entry], total: 1, hasMore: false, limit: 50 } }),
    );

    await page.goto(`/c/${campaignId}/compendium`);
    const href = `/c/${campaignId}/compendium/${entryId}`;
    const card = page.locator(`a[href="${href}"]`).first();
    await assertNativeAnchor(page, card, href);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });
});
