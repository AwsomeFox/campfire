/**
 * Representative-route color-contrast scans (issue #593, #1778).
 *
 * Exercises the authenticated shell on high-traffic routes where secondary,
 * timestamp, and muted copy is dense (AI table, notifications, sessions).
 * Scans full page including app chrome (<aside>, <header>, .cf-tabbar).
 */
import { test } from '@playwright/test';
import { assertAxeClean, createAxeBuilder } from '../lib/axe';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

const REPRESENTATIVE_ROUTES = [
  { path: () => '/', label: 'home' },
  { path: () => '/preferences', label: 'preferences' },
  { path: (c: number) => `/c/${c}`, label: 'dashboard' },
  { path: (c: number) => `/c/${c}/sessions`, label: 'sessions' },
  { path: (c: number) => `/c/${c}/quests`, label: 'quests' },
  { path: (c: number) => `/c/${c}/compendium`, label: 'compendium' },
];

test.describe('Representative route contrast (#593, #1778)', () => {
  for (const { path, label } of REPRESENTATIVE_ROUTES) {
    test(`${label} desktop contrast scan (chrome + main)`, async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(path(campaignId));
      await page.locator('main').waitFor({ state: 'visible' });

      const results = await createAxeBuilder(page)
        .withRules(['color-contrast'])
        .analyze();

      assertAxeClean(results, { maxIncompleteNodes: 80 });
    });

    test(`${label} mobile contrast scan (tabbar + main)`, async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(path(campaignId));
      await page.locator('main').waitFor({ state: 'visible' });

      const results = await createAxeBuilder(page)
        .withRules(['color-contrast'])
        .analyze();

      assertAxeClean(results, { maxIncompleteNodes: 80 });
    });
  }
});
