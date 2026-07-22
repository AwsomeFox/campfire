import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

function nextSteps(page: Page): Locator {
  return page.getByRole('region', { name: 'Next' });
}

test.describe('ended encounter next steps (issue #663)', () => {
  test.describe('DM', () => {
    test.use({ storageState: stateFor('dm') });

    test('a linked encounter offers session, recap, and XP hand-offs with keyboard entry', async ({ page }) => {
      const { campaignId, linkedEndedEncounterId, navigation } = seed();
      await page.goto(`/c/${campaignId}/encounters/${linkedEndedEncounterId}`);
      await expect(page.getByRole('heading', { name: 'Linked Aftermath at the Moon Gate' })).toBeVisible();

      const group = nextSteps(page);
      await expect(group).toBeVisible();
      await expect(group.getByRole('link', { name: /^Open linked session/ })).toHaveAttribute(
        'href',
        `/c/${campaignId}/sessions?session=${navigation.sessionId}`,
      );
      await expect(group.getByRole('link', { name: /^Award XP/ })).toHaveAttribute(
        'href',
        `/c/${campaignId}/party?action=award-xp`,
      );

      const recap = group.getByRole('link', { name: /^Write recap/ });
      await expect(recap).toHaveAttribute(
        'href',
        `/c/${campaignId}/sessions?session=${navigation.sessionId}&action=edit-recap`,
      );
      const accessibilityScan = await new AxeBuilder({ page })
        .include('[aria-labelledby="encounter-next-heading"]')
        .analyze();
      expect(accessibilityScan.violations).toEqual([]);

      await recap.focus();
      await expect(recap).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(
        `/c/${campaignId}/sessions?session=${navigation.sessionId}&action=edit-recap`,
      );
      await expect(page.getByRole('textbox', { name: 'Recap' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Recap' })).toBeFocused();
    });

    test('an unlinked encounter has no dead session link and stays usable on mobile', async ({ page }) => {
      const { campaignId, endedEncounterId } = seed();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/c/${campaignId}/encounters/${endedEncounterId}`);
      await expect(page.getByRole('heading', { name: 'Aftermath at the Ember Hearth' })).toBeVisible();

      const group = nextSteps(page);
      const recap = group.getByRole('link', { name: /^Write recap/ });
      const awardXp = group.getByRole('link', { name: /^Award XP/ });
      await expect(group.getByRole('link', { name: /^Open linked session/ })).toHaveCount(0);
      await expect(recap).toHaveAttribute('href', `/c/${campaignId}/sessions?action=new-recap`);
      await expect(awardXp).toHaveAttribute('href', `/c/${campaignId}/party?action=award-xp`);

      const groupBox = await group.boundingBox();
      const recapBox = await recap.boundingBox();
      const xpBox = await awardXp.boundingBox();
      expect(groupBox).not.toBeNull();
      expect(recapBox).not.toBeNull();
      expect(xpBox).not.toBeNull();
      expect(recapBox!.x).toBeGreaterThanOrEqual(groupBox!.x);
      expect(recapBox!.x + recapBox!.width).toBeLessThanOrEqual(groupBox!.x + groupBox!.width);
      expect(xpBox!.x).toBeGreaterThanOrEqual(groupBox!.x);
      expect(xpBox!.x + xpBox!.width).toBeLessThanOrEqual(groupBox!.x + groupBox!.width);
      expect(xpBox!.y).toBeGreaterThan(recapBox!.y);

      const accessibilityScan = await new AxeBuilder({ page })
        .include('[aria-labelledby="encounter-next-heading"]')
        .analyze();
      expect(accessibilityScan.violations).toEqual([]);

      await recap.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/c/${campaignId}/sessions?action=new-recap`);
      await expect(page.getByRole('heading', { name: /Add recap/ })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();

      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Aftermath at the Ember Hearth' })).toBeVisible();
      await awardXp.focus();
      await expect(awardXp).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/c/${campaignId}/party?action=award-xp`);
      await expect(page.getByRole('heading', { name: 'Award party XP' })).toBeVisible();
      await expect(page.getByRole('spinbutton', { name: 'XP to award each character' })).toBeFocused();
    });
  });

  test.describe('non-DM', () => {
    test.use({ storageState: stateFor('player') });

    test('post-encounter write actions remain hidden', async ({ page }) => {
      const { campaignId, linkedEndedEncounterId } = seed();
      await page.goto(`/c/${campaignId}/encounters/${linkedEndedEncounterId}`);
      await expect(page.getByRole('heading', { name: 'Linked Aftermath at the Moon Gate' })).toBeVisible();
      await expect(nextSteps(page)).toHaveCount(0);
    });
  });
});
