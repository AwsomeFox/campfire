import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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
 */

const CAMPAIGN_NAME = 'E2E — Cinderhaven';

async function openCampaignDeleteDialog(page: Page) {
  const trigger = page.getByRole('button', { name: 'Delete campaign…' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(page.getByTestId('confirm-destructive-dialog')).toBeVisible();
  return trigger;
}

test.describe('destructive confirmation dialog — campaign deletion (#775)', () => {
  test.use({ storageState: stateFor('dm') });

  test('dialog opens with correct focus on the confirmation input', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await openCampaignDeleteDialog(page);

    const dialog = page.getByTestId('confirm-destructive-dialog');
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    const input = page.getByTestId('confirm-destructive-input');
    await expect(input).toBeFocused();
  });

  test('cancel restores focus to the trigger button', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    const trigger = await openCampaignDeleteDialog(page);

    await page.getByTestId('confirm-destructive-cancel').click();
    await expect(page.getByTestId('confirm-destructive-dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('mismatch prevents submission — button disabled with non-color explanation', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await openCampaignDeleteDialog(page);
    const confirmBtn = page.getByTestId('confirm-destructive-confirm');
    const input = page.getByTestId('confirm-destructive-input');
    const hint = page.getByTestId('confirm-destructive-hint');

    await expect(confirmBtn).toBeDisabled();
    await expect(hint).toContainText('must type the exact name');

    await input.fill('E2E — Cinder');
    await expect(confirmBtn).toBeDisabled();
    await expect(hint).toContainText('must type the exact name');

    await input.fill('wrong name');
    await expect(confirmBtn).toBeDisabled();
  });

  test('exact match enables the destructive button', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await openCampaignDeleteDialog(page);
    const input = page.getByTestId('confirm-destructive-input');
    const confirmBtn = page.getByTestId('confirm-destructive-confirm');
    const hint = page.getByTestId('confirm-destructive-hint');

    await input.fill(CAMPAIGN_NAME);
    await expect(confirmBtn).toBeEnabled();
    await expect(hint).toContainText('Confirmed');

    await page.getByTestId('confirm-destructive-cancel').click();
  });

  test('server error is announced and associated with the input', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await openCampaignDeleteDialog(page);
    const input = page.getByTestId('confirm-destructive-input');
    const confirmBtn = page.getByTestId('confirm-destructive-confirm');

    await input.fill(CAMPAIGN_NAME);
    await expect(confirmBtn).toBeEnabled();

    await page.route(`**/api/v1/campaigns/${campaignId}`, (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Internal server error' } }),
        });
      }
      return route.continue();
    });

    await confirmBtn.click();

    const errorEl = page.getByTestId('confirm-destructive-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toHaveAttribute('role', 'alert');
    await expect(input).toHaveAttribute('aria-invalid', 'true');

    await page.unroute(`**/api/v1/campaigns/${campaignId}`);
  });

  test('successful delete routes away from settings', async ({ page }) => {
    seed();
    const trashName = `E2E trash ${Date.now()}`;
    const createRes = await page.request.post('/api/v1/campaigns', { data: { name: trashName } });
    expect(createRes.ok()).toBeTruthy();
    const { id: trashId } = (await createRes.json()) as { id: number };

    await page.goto(`/c/${trashId}/settings`);
    await openCampaignDeleteDialog(page);
    await page.getByTestId('confirm-destructive-input').fill(trashName);

    const [deleteRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes(`/api/v1/campaigns/${trashId}`) && res.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-destructive-confirm').click(),
    ]);
    expect(deleteRes.ok()).toBeTruthy();
    await expect(page).not.toHaveURL(new RegExp(`/c/${trashId}/settings`));
  });

  test('Escape key closes the dialog', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    const trigger = await openCampaignDeleteDialog(page);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-destructive-dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('keyboard Tab cycles within the dialog', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await openCampaignDeleteDialog(page);
    const input = page.getByTestId('confirm-destructive-input');
    const cancel = page.getByTestId('confirm-destructive-cancel');
    const confirm = page.getByTestId('confirm-destructive-confirm');

    await expect(input).toBeFocused();
    // Enable the destructive button so it stays in the tab order.
    await input.fill(CAMPAIGN_NAME);
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
  });

  test('axe accessibility check passes on the open dialog', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings`);

    await openCampaignDeleteDialog(page);

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
    const trigger = page.getByRole('button', { name: /delete my account/i });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    const dialog = page.getByTestId('confirm-destructive-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    const input = page.getByTestId('confirm-destructive-input');
    await expect(input).toBeFocused();
    await expect(dialog.locator('.dialog-title')).toBeVisible();
    await expect(dialog.locator('.dialog-body')).toBeVisible();
    await expect(page.getByTestId('confirm-destructive-confirm')).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('account deletion axe check passes', async ({ page }) => {
    await page.goto('/preferences');
    const trigger = page.getByRole('button', { name: /delete my account/i });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await expect(page.getByTestId('confirm-destructive-dialog')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="confirm-destructive-backdrop"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
