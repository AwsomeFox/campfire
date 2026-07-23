import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

/**
 * Issue #521 — New campaign wizard exposes a single page-level h1, step h2
 * headings in order, step-change announcements, and a descriptive document title.
 */

test.use({ storageState: stateFor('dm') });

test.describe('New campaign wizard headings (#521)', () => {
  test('uses one h1, h2 step headings, focus, announcements, and document title', async ({ page }) => {
    await page.goto('/?newCampaign=1');

    const pageTitle = page.getByRole('heading', { level: 1, name: 'New campaign' });
    await expect(pageTitle).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    const detailsHeading = page.getByRole('heading', { level: 2, name: 'Campaign details' });
    await expect(detailsHeading).toBeVisible();
    await expect(detailsHeading).toBeFocused();
    await expect(page).toHaveTitle('New campaign — Campaign details · Campfire');

    await page.getByLabel('Name').fill('Heading hierarchy test');
    await page.getByRole('button', { name: /Next: rule system/ }).click();

    const systemHeading = page.getByRole('heading', { level: 2, name: 'Rule system' });
    await expect(systemHeading).toBeVisible();
    await expect(systemHeading).toBeFocused();
    await expect(page).toHaveTitle('New campaign — Rule system · Campfire');

    const polite = page.locator('.sr-only[aria-live="polite"]');
    await expect.poll(async () => polite.textContent()).toContain('Rule system');

    await page.getByRole('button', { name: '← Back' }).click();
    await expect(detailsHeading).toBeVisible();
    await expect(detailsHeading).toBeFocused();
    await expect(page).toHaveTitle('New campaign — Campaign details · Campfire');
    await expect.poll(async () => polite.textContent()).toContain('Campaign details');

    const results = await new AxeBuilder({ page })
      .include('main[aria-labelledby="new-campaign-title"]')
      .analyze();
    expect(results.violations.filter((v) => v.id === 'heading-order')).toEqual([]);
  });
});
