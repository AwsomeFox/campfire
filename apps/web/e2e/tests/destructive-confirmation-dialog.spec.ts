import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #775 — destructive confirmations must use a shared, fully structured
 * and accessible dialog:
 *  - role="alertdialog" with aria-modal, aria-labelledby, aria-describedby
 *  - Focus moves to the confirmation input on open
 *  - Cancel restores focus to the trigger
 *  - Mismatch keeps the destructive button disabled (non-color explanation)
 *  - Exact match enables the button
 *  - Server errors are announced + associated via aria-invalid/aria-errormessage
 *  - Escape closes the dialog
 *  - axe-core passes on the open dialog
 *
 * Tests exercise the campaign-deletion flow (DM role). Account deletion is
 * tested in a separate describe block using the admin role to avoid destroying
 * the shared seeded user.
 */

test.describe('destructive confirmation dialog — campaign deletion (#775)', () => {
  test.use({ storageState: stateFor('dm') });

  const CAMPAIGN_NAME = 'E2E — Cinderhaven';

  test('dialog opens with correct focus on the confirmation input', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    const trigger = page.getByTestId('delete-campaign-trigger');
    await trigger.click();

    const dialog = page.getByTestId('confirm-destructive-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Focus should be on the confirmation input.
    const input = page.getByTestId('confirm-destructive-input');
    await expect(input).toBeFocused();
  });

  test('cancel restores focus to the trigger button', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    const trigger = page.getByTestId('delete-campaign-trigger');
    await trigger.click();

    await expect(page.getByTestId('confirm-destructive-dialog')).toBeVisible();

    // Click cancel.
    await page.getByTestId('confirm-destructive-cancel').click();
    await expect(page.getByTestId('confirm-destructive-dialog')).toHaveCount(0);

    // Focus should return to the trigger.
    await expect(trigger).toBeFocused();
  });

  test('mismatch prevents submission — button disabled with non-color explanation', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await page.getByTestId('delete-campaign-trigger').click();
    const dialog = page.getByTestId('confirm-destructive-dialog');
    const input = page.getByTestId('confirm-destructive-input');
    const confirmBtn = page.getByTestId('confirm-destructive-confirm');
    const hint = page.getByTestId('confirm-destructive-hint');

    // Initially disabled.
    await expect(confirmBtn).toBeDisabled();
    // Non-color text explanation is visible.
    await expect(hint).toContainText('must type the exact name');

    // Type a partial match — still disabled.
    await input.fill('E2E — Cinder');
    await expect(confirmBtn).toBeDisabled();
    await expect(hint).toContainText('must type the exact name');

    // Type the wrong thing entirely.
    await input.fill('wrong name');
    await expect(confirmBtn).toBeDisabled();
  });

  test('exact match enables the destructive button', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await page.getByTestId('delete-campaign-trigger').click();
    const input = page.getByTestId('confirm-destructive-input');
    const confirmBtn = page.getByTestId('confirm-destructive-confirm');
    const hint = page.getByTestId('confirm-destructive-hint');

    await input.fill(CAMPAIGN_NAME);
    await expect(confirmBtn).toBeEnabled();
    await expect(hint).toContainText('Confirmed');

    // Don't actually submit — we don't want to delete the shared seed campaign.
    await page.getByTestId('confirm-destructive-cancel').click();
  });

  test('server error is announced and associated with the input', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await page.getByTestId('delete-campaign-trigger').click();
    const input = page.getByTestId('confirm-destructive-input');
    const confirmBtn = page.getByTestId('confirm-destructive-confirm');

    await input.fill(CAMPAIGN_NAME);
    await expect(confirmBtn).toBeEnabled();

    // Intercept the DELETE and make it fail with 500.
    await page.route(`**/api/v1/campaigns/${campaignId}`, (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({ status: 500, body: JSON.stringify({ error: 'Internal server error' }) });
      }
      return route.continue();
    });

    await confirmBtn.click();

    // Error should appear.
    const errorEl = page.getByTestId('confirm-destructive-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toHaveAttribute('role', 'alert');

    // Input should be marked invalid.
    await expect(input).toHaveAttribute('aria-invalid', 'true');

    // Clean up route.
    await page.unroute(`**/api/v1/campaigns/${campaignId}`);
  });

  test('Escape key closes the dialog', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    const trigger = page.getByTestId('delete-campaign-trigger');
    await trigger.click();
    await expect(page.getByTestId('confirm-destructive-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-destructive-dialog')).toHaveCount(0);

    // Focus restored.
    await expect(trigger).toBeFocused();
  });

  test('axe accessibility check passes on the open dialog', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await page.getByTestId('delete-campaign-trigger').click();
    await expect(page.getByTestId('confirm-destructive-dialog')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="confirm-destructive-backdrop"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('destructive confirmation dialog — account deletion (#775)', () => {
  test.use({ storageState: stateFor('admin') });

  test('account deletion dialog opens with correct structure', async ({ page }) => {
    await page.goto('/preferences');
    const trigger = page.getByTestId('delete-account-trigger');
    await trigger.click();

    const dialog = page.getByTestId('confirm-destructive-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Focus on input.
    const input = page.getByTestId('confirm-destructive-input');
    await expect(input).toBeFocused();

    // Has the title and consequence description.
    await expect(dialog.locator('.dialog-title')).toBeVisible();
    await expect(dialog.locator('.dialog-body')).toBeVisible();

    // Button should be disabled initially (name not typed).
    await expect(page.getByTestId('confirm-destructive-confirm')).toBeDisabled();

    // Cancel and verify focus returns.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('account deletion axe check passes', async ({ page }) => {
    await page.goto('/preferences');
    await page.getByTestId('delete-account-trigger').click();
    await expect(page.getByTestId('confirm-destructive-dialog')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="confirm-destructive-backdrop"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
