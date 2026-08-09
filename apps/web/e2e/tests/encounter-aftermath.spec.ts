import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';
import { openCockpitTab } from '../lib/encounterCockpit';

test.describe('ended encounter aftermath workflow (issue #473)', () => {
  test.describe('DM', () => {
    test.use({ storageState: stateFor('dm') });

    test('a linked encounter offers recap draft, loot, quest, and XP hand-offs', async ({ page }) => {
      const { campaignId, linkedEndedEncounterId, navigation } = seed();
      await page.goto(`/c/${campaignId}/encounters/${linkedEndedEncounterId}`);
      await openCockpitTab(page, 'table');
      await expect(page.getByRole('heading', { name: 'Linked Aftermath at the Moon Gate' })).toBeVisible();

      const panel = page.locator('[aria-labelledby="encounter-aftermath-heading"]');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'Aftermath' })).toBeVisible();
      await expect(panel.getByLabel('Recap draft seeded from this encounter')).toContainText('##');

      const recap = panel.getByRole('link', { name: /^Write recap/ });
      await expect(recap).toHaveAttribute(
        'href',
        `/c/${campaignId}/sessions?session=${navigation.sessionId}&action=edit-recap&fromEncounter=${linkedEndedEncounterId}`,
      );
      await expect(panel.getByRole('link', { name: /^Award XP/ })).toHaveAttribute(
        'href',
        new RegExp(`^/c/${campaignId}/party\\?action=award-xp`),
      );
      await expect(panel.getByRole('link', { name: /^Distribute loot/ })).toHaveAttribute(
        'href',
        `/c/${campaignId}/inventory?action=add-item&fromEncounter=${linkedEndedEncounterId}`,
      );
      await expect(panel.getByRole('link', { name: /^Update quest/ })).toHaveCount(1);
      await expect(panel.getByRole('link', { name: /^Open linked session/ })).toHaveAttribute(
        'href',
        `/c/${campaignId}/sessions?session=${navigation.sessionId}`,
      );

      const accessibilityScan = await new AxeBuilder({ page })
        .include('[aria-labelledby="encounter-aftermath-heading"]')
        .analyze();
      expect(accessibilityScan.violations).toEqual([]);

      await recap.focus();
      await expect(recap).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(
        `/c/${campaignId}/sessions?session=${navigation.sessionId}&action=edit-recap&fromEncounter=${linkedEndedEncounterId}`,
      );
      await expect(page.getByRole('textbox', { name: 'Recap' })).toBeVisible();
    });

    test('an unlinked encounter supports defer and loot hand-off on mobile', async ({ page }) => {
      const { campaignId, endedEncounterId } = seed();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/c/${campaignId}/encounters/${endedEncounterId}`);
      await openCockpitTab(page, 'table');
      await expect(page.getByRole('heading', { name: 'Aftermath at the Ember Hearth' })).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      const panel = page.locator('[aria-labelledby="encounter-aftermath-heading"]');
      const recap = panel.getByRole('link', { name: /^Write recap/ });
      const loot = panel.getByRole('link', { name: /^Distribute loot/ });
      await expect(panel.getByRole('link', { name: /^Update quest/ })).toHaveCount(0);
      await expect(recap).toHaveAttribute(
        'href',
        `/c/${campaignId}/sessions?action=new-recap&fromEncounter=${endedEncounterId}`,
      );
      await expect(loot).toHaveAttribute(
        'href',
        `/c/${campaignId}/inventory?action=add-item&fromEncounter=${endedEncounterId}`,
      );

      await panel.getByRole('button', { name: 'Remind me later' }).click();
      await expect(panel.getByRole('button', { name: 'Show aftermath' })).toBeVisible();

      await panel.getByRole('button', { name: 'Show aftermath' }).click();
      await loot.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/c/${campaignId}/inventory?action=add-item&fromEncounter=${endedEncounterId}`);
    });
  });

  test.describe('non-DM', () => {
    test.use({ storageState: stateFor('player') });

    test('post-encounter aftermath remains hidden', async ({ page }) => {
      const { campaignId, linkedEndedEncounterId } = seed();
      await page.goto(`/c/${campaignId}/encounters/${linkedEndedEncounterId}`);
      await openCockpitTab(page, 'table');
      await expect(page.getByRole('heading', { name: 'Linked Aftermath at the Moon Gate' })).toBeVisible();
      await expect(page.locator('[aria-labelledby="encounter-aftermath-heading"]')).toHaveCount(0);
    });
  });
});
