/**
 * Representative-route color-contrast scans (issue #593).
 *
 * Exercises the authenticated shell on high-traffic routes where secondary,
 * timestamp, and muted copy is dense (AI table, notifications, sessions).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

const REPRESENTATIVE_ROUTES = (campaignId: number) => [
  { path: '/', label: 'home' },
  { path: '/preferences', label: 'preferences' },
  { path: `/c/${campaignId}`, label: 'dashboard' },
  { path: `/c/${campaignId}/sessions`, label: 'sessions' },
  { path: `/c/${campaignId}/quests`, label: 'quests' },
  { path: `/c/${campaignId}/compendium`, label: 'compendium' },
];

test.describe('Representative route contrast (#593)', () => {
  for (const { path, label } of REPRESENTATIVE_ROUTES(seed().campaignId)) {
    test(`${label} has no color-contrast violations`, async ({ page }) => {
      await page.goto(path);
      await page.locator('main').waitFor({ state: 'visible' });

      const results = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze();

      expect(
        results.violations,
        results.violations
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)
          .join('\n'),
      ).toEqual([]);
    });
  }
});
