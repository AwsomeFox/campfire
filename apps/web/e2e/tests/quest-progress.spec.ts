import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { QUEST_NEXT_OBJECTIVE } from '../global-setup';
import { seed, stateFor } from './seed';

test.describe('quest-board objective progress', () => {
  test.use({ storageState: stateFor('dm') });

  test('reflows long next-step text on mobile with an accessible full-size detail affordance', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/c/${fixture.campaignId}/quests`);

    const card = page.getByTestId(`quest-card-${fixture.quests.active.id}`);
    await expect(card).toBeVisible();
    await expect(card.getByText('1 of 3 objectives complete')).toBeVisible();
    await expect(card.getByRole('progressbar', { name: `Objective progress for ${fixture.quests.active.title}` }))
      .toHaveAttribute('aria-valuenow', '1');

    const nextStep = card.locator('.quest-next-step');
    await expect(nextStep).toContainText('Continue:');
    await expect(nextStep).toContainText(QUEST_NEXT_OBJECTIVE);
    await expect(card.getByRole('checkbox')).toHaveCount(0);

    const details = card.getByRole('link', { name: `View details for ${fixture.quests.active.title}` });
    const detailBox = await details.boundingBox();
    expect(detailBox?.height).toBeGreaterThanOrEqual(44);

    const layout = await card.evaluate((element) => ({
      cardClientWidth: element.clientWidth,
      cardScrollWidth: element.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.cardScrollWidth).toBeLessThanOrEqual(layout.cardClientWidth);
    expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);

    const accessibilityScan = await new AxeBuilder({ page }).include(`[data-testid="quest-card-${fixture.quests.active.id}"]`).analyze();
    expect(accessibilityScan.violations).toEqual([]);
    await test.info().attach('quest-progress-mobile-long-text', {
      body: await card.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  test('opens quest details from the keyboard affordance', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/quests`);

    const details = page
      .getByTestId(`quest-card-${fixture.quests.active.id}`)
      .getByRole('link', { name: `View details for ${fixture.quests.active.title}` });
    await details.focus();
    await expect(details).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/c/${fixture.campaignId}/quests/${fixture.quests.active.id}$`));
    await expect(page.getByRole('heading', { name: fixture.quests.active.title })).toBeVisible();
  });
});
