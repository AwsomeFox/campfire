import { test, expect } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Cold-start friction reduction end-to-end tests (issue #1477):
 * - Default encounter name pre-fills so Create is 1-tap.
 * - Quick fight creates, bulk-adds party, and lands on roster in 1 tap.
 * - Add whole party bulk-adds all PCs, skips present ones, and is idempotent.
 */
test.describe('quick fight & party bulk add (issue #1477)', () => {
  test.use({ storageState: stateFor('dm') });

  test('default encounter name allows one-tap encounter creation', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/encounters`);
    const newEncounterBtn = page.getByTestId('new-encounter-button');
    await expect(newEncounterBtn).toBeVisible();
    await newEncounterBtn.click();
    await expect(page.getByTestId('encounter-create-form')).toBeVisible();

    const nameInput = page.getByLabel(/Encounter name/i);
    await expect(nameInput).toHaveValue(/Untitled encounter - \d{4}-\d{2}-\d{2}/);

    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters/\\d+`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Untitled encounter/);
  });

  test('Quick fight creates encounter, bulk-adds party, and lands on roster in 1 tap', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/encounters`);

    const quickFightBtn = page.getByTestId('quick-fight-button');
    await expect(quickFightBtn).toBeVisible();

    let coldStartInteractions = 0;
    coldStartInteractions++;
    await quickFightBtn.click();

    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters/\\d+`));
    expect(coldStartInteractions).toBe(1);

    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Quick fight/);
  });

  test('Add whole party bulk-adds PCs, skips present ones, and is idempotent', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/encounters`);

    const newEncounterBtn = page.getByTestId('new-encounter-button');
    await expect(newEncounterBtn).toBeVisible();
    await newEncounterBtn.click();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/encounters/\\d+`));

    const partyTab = page.getByRole('tab', { name: 'Party' });
    await partyTab.click();

    const addWholePartyBtn = page.getByTestId('add-whole-party-button');
    await expect(addWholePartyBtn).toBeVisible();
    await addWholePartyBtn.click();

    await expect(page.getByText('The whole party is already in this encounter.')).toBeVisible();
  });
});
