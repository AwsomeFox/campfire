import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { validateHeadingOutline } from '../../src/lib/headingOutline';
import { seed, stateFor } from './seed';

/**
 * Issue #457 — Quests, Storylines, Timeline, and Admin Users expose one
 * descriptive h1 per route, ordered section headings, and meaningful record
 * headings without duplicate adjacent titles.
 */

test.describe('Page heading hierarchy (#457)', () => {
  test.use({ storageState: stateFor('dm') });

  test('campaign quests, storylines, and timeline keep a valid outline', async ({ page }) => {
    const { campaignId } = seed();

    const routes = [
      {
        path: `/c/${campaignId}/quests`,
        pageTitle: 'Quests',
        recordHeading: 'DLRNAV Grand Route',
      },
      {
        path: `/c/${campaignId}/storylines`,
        pageTitle: 'Storylines',
        recordHeading: 'DLRNAV Ember Arc',
        nestedHeading: 'DLRNAV Broken Oath',
      },
      {
        path: `/c/${campaignId}/timeline`,
        pageTitle: 'Timeline',
        sectionHeading: 'Current in-world date',
        recordHeading: 'DLRNAV Sundering',
      },
    ] as const;

    for (const route of routes) {
      await page.goto(route.path);
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1, name: route.pageTitle })).toHaveCount(1);

      const outline = await main.evaluate((el) => {
        const nodes = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
        return nodes.map((node) => ({
          level: Number(node.tagName.slice(1)),
          text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        }));
      });
      expect(validateHeadingOutline(outline), `${route.path} outline`).toEqual([]);

      await expect(main.getByRole('heading', { level: 2, name: route.recordHeading })).toBeVisible();
      if ('sectionHeading' in route) {
        await expect(main.getByRole('heading', { level: 2, name: route.sectionHeading })).toBeVisible();
      }
      if ('nestedHeading' in route) {
        await expect(main.getByRole('heading', { level: 3, name: route.nestedHeading })).toBeVisible();
      }

      const results = await new AxeBuilder({ page }).include('main').analyze();
      expect(
        results.violations.filter((v) => v.id === 'heading-order' || v.id === 'page-has-heading-one'),
        `${route.path} axe`,
      ).toEqual([]);
    }
  });

  test('admin users keeps one h1 and distinct section headings', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('admin') });
    const page = await context.newPage();

    await page.goto('/admin/users');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Users' })).toHaveCount(1);
    await expect(main.getByRole('heading', { level: 2, name: 'All accounts' })).toBeVisible();
    await expect(main.getByRole('heading', { level: 2, name: 'Users' })).toHaveCount(0);

    const outline = await main.evaluate((el) => {
      const nodes = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      return nodes.map((node) => ({
        level: Number(node.tagName.slice(1)),
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }));
    });
    expect(validateHeadingOutline(outline)).toEqual([]);

    const results = await new AxeBuilder({ page }).include('main').analyze();
    expect(results.violations.filter((v) => v.id === 'heading-order' || v.id === 'page-has-heading-one')).toEqual([]);

    await context.close();
  });
});
