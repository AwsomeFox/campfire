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

  /**
   * Issue #1711 — the Dashboard shipped no `<h1>` at all: `StatusHeader.tsx` rendered
   * `<h3 className="cf-page-title" style={{ fontSize: '1.35rem' }}>`, an `<h3>` wearing
   * `<PageTitle>`'s CSS class rather than the component itself. Filed as a sibling of
   * #649/#1640/#1653: a rule (exactly one real `<h1>` per top-level route) enforced at
   * most call sites and silently not at this one. The audit this issue asked for found
   * two more: a quest's detail page (`QuestPage.tsx`) had its only real `<h1>` inside the
   * screen-hidden `<PrintOnly>` reference sheet — the VISIBLE title was a bare `<h3>` with
   * no size override at all (Tailwind preflight resets heading font-size to `inherit`, so
   * it rendered at plain body size). And the AI-DM Table (`AiTablePage.tsx`) had no
   * heading element whatsoever in any of its states (loading / gated-off / co-dm / live).
   *
   * These three routes are pinned individually (rather than folded into the loop above)
   * so a future regression on any one of them fails with an unambiguous test name.
   */
  test('Dashboard uses PageTitle (not an <h3> wearing its class) for the campaign name', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}`);
    await expectOnePageH1(page, 'E2E — Cinderhaven');
  });

  test('a quest detail page has a real (non-print-only) <h1>, not a bare <h3>', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    await expectOnePageH1(page, 'DLRNAV Grand Route');
  });

  test('the AI-DM Table has a page heading in every state (loading / gated / live)', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/table`);
    // No `main.getByRole` wrapper here (unlike expectOnePageH1) — the point of this test
    // is that a heading exists at all, in whichever state the seeded campaign's AI-DM
    // seat happens to be in (loading / off / co-dm / live all render their own sr-only
    // PageTitle rather than sharing one wrapper — see AiTablePage.tsx).
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveAccessibleName('Table');
  });
});
