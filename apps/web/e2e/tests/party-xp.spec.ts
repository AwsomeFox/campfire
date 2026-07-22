import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('party XP recipient preview and historical correction (issue #814)', () => {
  test.use({ storageState: stateFor('dm') });

  test('defaults to active, requires explicit legacy opt-in, and awards the exact keyboard-selected recipients', async ({ page }) => {
    const { campaignId, xpRecipients } = seed();
    await page.goto(`/c/${campaignId}/party`);

    const trigger = page.getByRole('button', { name: /Award XP$/ });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const heading = page.getByRole('heading', { name: 'Award party XP' });
    await expect(heading).toBeVisible();
    const amount = page.getByRole('spinbutton', { name: 'XP to award each character' });
    await expect(amount).toBeFocused();
    await amount.fill('125');

    const active = page.getByRole('checkbox', {
      name: `Select ${xpRecipients.active.name} (Active) for XP award`,
    });
    const retired = page.getByRole('checkbox', {
      name: `Select ${xpRecipients.retired.name} (Retired) for XP award`,
    });
    const dead = page.getByRole('checkbox', {
      name: `Select ${xpRecipients.dead.name} (Dead) for XP award`,
    });
    const inactive = page.getByRole('checkbox', {
      name: `Select ${xpRecipients.inactive.name} (Inactive) for XP award`,
    });
    const legacyOptIn = page.getByRole('checkbox', { name: /Include inactive, retired, or dead characters/ });

    await expect(active).toBeChecked();
    await expect(retired).not.toBeChecked();
    await expect(retired).toBeDisabled();
    await expect(dead).toBeDisabled();
    await expect(inactive).toBeDisabled();

    // The Playwright project deliberately shares one backend. Earlier combat
    // journeys may add another active PC, so narrow the exact selection back to
    // this spec's named active fixture before asserting/committing recipients.
    for (const checkbox of await page.locator('#party-xp-form tbody input[type="checkbox"]:checked').all()) {
      if ((await checkbox.getAttribute('aria-label')) !== `Select ${xpRecipients.active.name} (Active) for XP award`) {
        await checkbox.uncheck();
      }
    }
    await expect(page.getByText('1 recipient selected.')).toBeVisible();

    const activeRow = page.getByRole('row').filter({ hasText: xpRecipients.active.name });
    await expect(activeRow).toContainText('Active');
    await expect(activeRow).toContainText('100');
    await expect(activeRow).toContainText('225');

    // Keyboard path: amount -> explicit legacy opt-in -> retired recipient.
    await amount.press('Tab');
    await expect(legacyOptIn).toBeFocused();
    await page.keyboard.press('Space');
    await expect(legacyOptIn).toBeChecked();
    await expect(retired).toBeEnabled();
    await expect(retired).not.toBeChecked();
    await retired.focus();
    await page.keyboard.press('Space');
    await expect(retired).toBeChecked();

    const retiredRow = page.getByRole('row').filter({ hasText: xpRecipients.retired.name });
    await expect(retiredRow).toContainText('Retired');
    await expect(retiredRow).toContainText('200');
    await expect(retiredRow).toContainText('325');
    await expect(page.getByText('2 recipients selected.')).toBeVisible();

    const accessibilityScan = await new AxeBuilder({ page }).include('.party-xp-card').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    const [response] = await Promise.all([
      page.waitForResponse((res) =>
        res.url().endsWith(`/api/v1/campaigns/${campaignId}/characters/xp`) && res.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Award XP to 2 recipients' }).click(),
    ]);
    expect(response.status()).toBe(201);
    const awarded = await response.json() as Array<{ id: number; xp: number }>;
    expect(awarded.map((character) => character.id)).toEqual([xpRecipients.active.id, xpRecipients.retired.id]);

    await expect(heading).toBeHidden();
    const rosterResponse = await page.request.get(`/api/v1/campaigns/${campaignId}/characters`);
    expect(rosterResponse.ok()).toBe(true);
    const roster = await rosterResponse.json() as Array<{ id: number; xp: number }>;
    const xpById = new Map(roster.map((character) => [character.id, character.xp]));
    expect(xpById.get(xpRecipients.active.id)).toBe(225);
    expect(xpById.get(xpRecipients.retired.id)).toBe(325);
    expect(xpById.get(xpRecipients.dead.id)).toBe(300);
    expect(xpById.get(xpRecipients.inactive.id)).toBe(400);
  });
});
