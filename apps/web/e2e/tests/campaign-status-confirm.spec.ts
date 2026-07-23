import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #640 — campaign status changes that make the whole campaign read-only
 * (Active → Paused/Completed) must require explicit confirmation and offer an
 * immediate Undo, rather than applying the instant the DM picks the option.
 *
 * Coverage:
 *   (a) selecting Paused arms a preview + consequence, NOT an immediate PATCH,
 *   (b) the confirmation modal distinguishes the archiving directions,
 *   (c) confirming PATCHes and surfaces an Undo snackbar,
 *   (d) Undo reverts the campaign to Active without a second confirm,
 *   (e) the recovery direction (Paused → Active) PATCHes directly with no
 *       confirm (the edit itself is the recovery),
 *   (f) the flow is keyboard-drivable and axe-clean on mobile.
 *
 * Serial — shares one seeded backend with every other spec, so a status change
 * that escapes cleanup would poison downstream tests. Each test restores the
 * campaign to Active before finishing.
 */

const STATUS_URL = (campaignId: number) => `/c/${campaignId}/settings`;

test.describe.configure({ mode: 'serial' });

test.describe('campaign status confirmation + undo (#640)', () => {
  test.use({ storageState: stateFor('dm') });

  test('archiving requires a preview + consequence confirmation, not fire-on-change', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(STATUS_URL(campaignId));
    const card = page.getByTestId('campaign-status-settings');

    // Sanity: starts Active.
    await expect(card.getByLabel('Campaign status')).toHaveValue('active');

    // Picking Paused arms a preview; it does NOT PATCH and does NOT open the modal.
    await card.getByLabel('Campaign status').selectOption('paused');
    const preview = card.getByTestId('status-change-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByText('Active', { exact: true })).toBeVisible();
    await expect(preview.getByText('Paused', { exact: true })).toBeVisible();
    await expect(preview.getByText(/read-only for everyone/)).toBeVisible();
    await expect(preview.getByRole('button', { name: /Apply Paused/ })).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // ConfirmDialog is NOT yet open — the select alone must not open it.
    await expect(page.getByRole('dialog', { name: /Archive this campaign as Paused/ })).toHaveCount(0);

    // Apply arms the modal (requestConfirm → confirming phase).
    await preview.getByRole('button', { name: /Apply Paused/ }).click();
    await expect(page.getByRole('dialog', { name: /Archive this campaign as Paused/ })).toBeVisible();

    // Cancel the modal — returns to PREVIEW (not idle), so the DM keeps the pick.
    await page.getByRole('dialog', { name: /Archive this campaign as Paused/ }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: /Archive this campaign as Paused/ })).toHaveCount(0);
    await expect(preview).toBeVisible();
    await expect(card.getByLabel('Campaign status')).toHaveValue('paused');

    // Now cancel the preview — nothing PATCHed, back to idle/active.
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await expect(preview).toHaveCount(0);
    await expect(card.getByLabel('Campaign status')).toHaveValue('active');
  });

  test('confirming Paused PATCHes, surfaces Undo, and Undo reverts to Active', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(STATUS_URL(campaignId));
    const card = page.getByTestId('campaign-status-settings');

    await card.getByLabel('Campaign status').selectOption('paused');
    await card.getByTestId('status-change-preview').getByRole('button', { name: /Apply Paused/ }).click();

    const dialog = page.getByRole('dialog', { name: /Archive this campaign as Paused/ });
    // Consequence copy distinguishes Paused from Completed.
    await expect(dialog.getByText(/read-only for everyone/)).toBeVisible();

    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/campaigns/${campaignId}`) && r.request().method() === 'PATCH',
      ),
      dialog.getByRole('button', { name: /Archive as Paused/ }).click(),
    ]);
    expect(patchResponse.ok()).toBe(true);
    expect((await patchResponse.request().postDataJSON()).status).toBe('paused');

    // The status now reads Paused and the Undo snackbar is armed.
    await expect(card.getByLabel('Campaign status')).toHaveValue('paused');
    const undo = card.getByTestId('status-change-undo');
    await expect(undo).toBeVisible();
    await expect(undo.getByRole('button', { name: 'Undo' })).toBeVisible();

    const [undoResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/campaigns/${campaignId}`) && r.request().method() === 'PATCH',
      ),
      undo.getByRole('button', { name: 'Undo' }).click(),
    ]);
    expect(undoResponse.ok()).toBe(true);
    expect((await undoResponse.request().postDataJSON()).status).toBe('active');

    await expect(card.getByLabel('Campaign status')).toHaveValue('active');
    await expect(card.getByTestId('status-change-undo')).toHaveCount(0);
  });

  test('recovery direction (Paused → Active) PATCHes directly without a confirm', async ({ page }) => {
    const { campaignId } = seed();

    // First drive the campaign into Paused via the API so the test starts from
    // a known-archived state, then exercise the un-archive path through the UI.
    await page.request.patch(`/api/v1/campaigns/${campaignId}`, { data: { status: 'paused' } });
    await page.goto(STATUS_URL(campaignId));
    const card = page.getByTestId('campaign-status-settings');
    await expect(card.getByLabel('Campaign status')).toHaveValue('paused');

    // Selecting Active is the recovery direction — no preview, no confirm.
    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/campaigns/${campaignId}`) && r.request().method() === 'PATCH',
      ),
      card.getByLabel('Campaign status').selectOption('active'),
    ]);
    expect(patchResponse.ok()).toBe(true);
    expect((await patchResponse.request().postDataJSON()).status).toBe('active');

    // No preview, no confirm dialog, no undo snackbar for the safe direction.
    await expect(card.getByTestId('status-change-preview')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /Archive this campaign/ })).toHaveCount(0);
    await expect(card.getByTestId('status-change-undo')).toHaveCount(0);
    await expect(card.getByLabel('Campaign status')).toHaveValue('active');
  });

  test('Completed confirmation distinguishes it from Paused (finished story)', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(STATUS_URL(campaignId));
    const card = page.getByTestId('campaign-status-settings');

    await card.getByLabel('Campaign status').selectOption('completed');
    await card.getByTestId('status-change-preview').getByRole('button', { name: /Apply Completed/ }).click();

    const dialog = page.getByRole('dialog', { name: /Archive this campaign as Completed/ });
    await expect(dialog).toBeVisible();
    // Completed-specific consequence copy.
    await expect(dialog.getByText(/marking the story finished/)).toBeVisible();

    // Cancel the modal → back to preview, then cancel the preview → idle.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    const preview = card.getByTestId('status-change-preview');
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await expect(card.getByLabel('Campaign status')).toHaveValue('active');
  });

  test('preview can be cancelled without PATCHing (escape the mis-click)', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(STATUS_URL(campaignId));
    const card = page.getByTestId('campaign-status-settings');

    await card.getByLabel('Campaign status').selectOption('paused');
    const preview = card.getByTestId('status-change-preview');
    await expect(preview).toBeVisible();

    // Cancel from the preview card — not the modal.
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await expect(preview).toHaveCount(0);
    await expect(card.getByLabel('Campaign status')).toHaveValue('active');
  });

  test('flow is keyboard-drivable and axe-clean on mobile', async ({ browser }) => {
    const { campaignId } = seed();
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    try {
      await page.goto(STATUS_URL(campaignId));
      const card = page.getByTestId('campaign-status-settings');

      // Select Paused (selectOption fires the change event reliably across
      // browsers, unlike ArrowDown on a native select) — preview arms.
      await card.getByLabel('Campaign status').selectOption('paused');
      const preview = card.getByTestId('status-change-preview');
      await expect(preview).toBeVisible();

      // Keyboard: focus the Apply button and activate with Enter → modal opens.
      await preview.getByRole('button', { name: /Apply Paused/ }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: /Archive this campaign as Paused/ })).toBeVisible();

      const mobileAxe = await new AxeBuilder({ page })
        .include('[data-testid="campaign-status-settings"]')
        .analyze();
      expect(mobileAxe.violations).toEqual([]);

      // Escape cancels the modal via ConfirmDialog's keyboard handler → returns
      // to preview (NOT idle), so the DM keeps the pending pick.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: /Archive this campaign as Paused/ })).toHaveCount(0);
      await expect(preview).toBeVisible();

      // Keyboard: focus the preview's Cancel and Enter → returns to idle.
      await preview.getByRole('button', { name: 'Cancel' }).focus();
      await page.keyboard.press('Enter');
      await expect(preview).toHaveCount(0);
      await expect(card.getByLabel('Campaign status')).toHaveValue('active');

      // No horizontal overflow on mobile.
      const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
    } finally {
      await context.close();
    }
  });
});
