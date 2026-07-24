import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #649 — top-level screens expose exactly one route-level h1 so heading
 * order and route-change focus stay coherent.
 */

test.use({ storageState: stateFor('dm') });

async function expectOnePageH1(page: Page, name: string | RegExp) {
  const h1 = page.locator('main').getByRole('heading', { level: 1 });
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveAccessibleName(name);
}

test.describe('Route-level page titles (#649)', () => {
  test('home, preferences, and campaign surfaces use one h1 each', async ({ page }) => {
    await page.goto('/');
    await expectOnePageH1(page, 'Your campaigns');
    await expect(page).toHaveTitle(/Your campaigns · Campfire/);

    await page.goto('/preferences');
    await expectOnePageH1(page, 'Preferences');

    const { campaignId } = seed();
    const routes: Array<{ path: string; name: string }> = [
      { path: `/c/${campaignId}/compendium`, name: 'Compendium' },
      { path: `/c/${campaignId}/session-zero`, name: 'Session Zero' },
      { path: `/c/${campaignId}/settings`, name: 'Campaign settings' },
      { path: `/c/${campaignId}/timeline`, name: 'Timeline' },
      { path: `/c/${campaignId}/storylines`, name: 'Storylines' },
      { path: `/c/${campaignId}/quests`, name: 'Quests' },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await expectOnePageH1(page, route.name);
    }

    // Representative axe check on a surface that also has a section h2.
    await page.goto(`/c/${campaignId}/session-zero`);
    await expect(page.getByRole('heading', { level: 2, name: 'Access support' })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('main').analyze();
    expect(
      results.violations.filter((v) => v.id === 'heading-order' || v.id === 'page-has-heading-one'),
    ).toEqual([]);
  });
});
