import { expect, test } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('keyboard command layer (issue #672)', () => {
  test.use({ storageState: stateFor('dm') });

  test('opens global search, quick capture, and shortcut help from anywhere in campaign', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/quests`);

    await page.keyboard.press(`${MODIFIER}+KeyK`);
    await expect(page.getByRole('dialog', { name: 'Search campaign' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press(`${MODIFIER}+Shift+KeyN`);
    await expect(page.getByRole('dialog', { name: 'Quick capture' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Shift+Slash');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change' }).first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('does not fire shortcuts while typing in an editor', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/search`);

    const search = page.getByRole('textbox', { name: 'Search this campaign' });
    await search.focus();
    await page.keyboard.press(`${MODIFIER}+KeyK`);
    await expect(page.getByRole('dialog', { name: 'Search campaign' })).toHaveCount(0);
  });

  test('does not fire guarded next turn while a confirm dialog is open', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await restoreSeedEncounter(page);
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press(`${MODIFIER}+Period`);
    // Confirm dialog still open — next turn must not have dismissed it.
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('exposes aria-keyshortcuts on next turn when running', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await restoreSeedEncounter(page);
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const nextTurn = page.getByRole('button', { name: 'Next turn →' });
    await expect(nextTurn).toBeVisible();
    await expect(nextTurn).toHaveAttribute('aria-keyshortcuts', /.+/);
  });
});
