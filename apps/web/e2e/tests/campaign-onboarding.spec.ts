import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

test.describe('campaign one-shot onboarding (#507)', () => {
  test('mobile dashboard guide has one next action, deep links steps, and supports solo skip/resume', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 390, height: 844 },
    });

    try {
      const created = await context.request.post('/api/v1/campaigns', {
        data: { name: `One-shot onboarding ${Date.now()}` },
      });
      expect(created.ok()).toBe(true);
      const campaign = (await created.json()) as { id: number };

      const page = await context.newPage();
      await page.addInitScript((campaignId) => {
        localStorage.removeItem(`cf.campaignOnboarding.${campaignId}`);
      }, campaign.id);
      await page.goto(`/c/${campaign.id}`);

      const card = page.getByTestId('campaign-onboarding-card');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('campaign-onboarding-next')).toContainText('Invite the table');
      await expect(card.getByRole('link', { name: 'Open invites' })).toHaveAttribute('href', `/c/${campaign.id}/members#invite`);

      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);

      await card.getByRole('button', { name: 'Show checklist' }).click();
      await expect(card.getByTestId('campaign-onboarding-step-invite')).toBeVisible();
      await expect(card.getByTestId('campaign-onboarding-step-party')).toBeVisible();

      const accessibilityScan = await new AxeBuilder({ page })
        .include('[data-testid="campaign-onboarding-card"]')
        .analyze();
      expect(accessibilityScan.violations).toEqual([]);

      await card.getByRole('button', { name: 'Playing solo' }).click();
      await expect(page.getByTestId('campaign-onboarding-next')).toContainText('Add the party');
      await expect(card.getByTestId('campaign-onboarding-step-invite')).toHaveCount(0);

      await card.getByRole('button', { name: 'Skip tour' }).click();
      await expect(page.getByTestId('campaign-onboarding-resume')).toBeVisible();
      const polite = page.locator('div[aria-live="polite"][aria-atomic="true"]');
      await expect(polite).toContainText(/guide skipped/i);

      await page.getByTestId('campaign-onboarding-resume').getByRole('button', { name: 'Resume guide' }).click();
      await expect(page.getByTestId('campaign-onboarding-card')).toBeVisible();
      await expect(page.getByTestId('campaign-onboarding-step-party')).toBeVisible();
      await expect(polite).toContainText(/guide resumed/i);
    } finally {
      await context.close();
    }
  });
});
