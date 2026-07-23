import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #459 — Inventory Add item must name the quantity control with an
 * associated Quantity label (not placeholder-only), expose min/max/step plus
 * validation help, announce field errors, and stay axe-clean.
 * Issue #633 — quantity stays type="text" + inputMode="numeric" so locale
 * parsing via parseLocalizedInteger is not bypassed by a number input.
 */

test.describe('inventory add-item quantity accessibility (#459)', () => {
  test.use({ storageState: stateFor('dm') });

  test('labels Quantity with constraints, announces validation errors, and is axe-clean', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/inventory`);

    await page.getByRole('button', { name: '+ Add item' }).click();
    const form = page.getByTestId('inventory-add-item');
    await expect(form.getByRole('heading', { name: 'Add item' })).toBeVisible();

    // textbox (not spinbutton): type="text" + inputMode="numeric" for #633.
    const quantity = form.getByRole('textbox', { name: 'Quantity' });
    await expect(quantity).toBeVisible();
    await expect(quantity).toHaveAttribute('type', 'text');
    await expect(quantity).toHaveAttribute('inputmode', 'numeric');
    await expect(quantity).toHaveAttribute('min', '0');
    await expect(quantity).toHaveAttribute('max', '1000000');
    await expect(quantity).toHaveAttribute('step', '1');
    await expect(quantity).toHaveAccessibleDescription(/Whole number from 0 to 1,000,000, step 1/);

    // Placeholder-only naming must not be the accessible name.
    await expect(quantity).not.toHaveAttribute('placeholder', 'Qty');
    await expect(form.getByLabel('Quantity')).toHaveCount(1);

    await form.getByRole('textbox', { name: /Item name/ }).fill('Labeled torch');
    await quantity.fill('-3');
    await form.getByRole('button', { name: 'Add' }).click();

    const qtyError = form.getByRole('alert').filter({ hasText: /Must be 0 or higher/ });
    await expect(qtyError).toBeVisible();
    await expect(quantity).toHaveAttribute('aria-invalid', 'true');
    await expect(quantity).toHaveAccessibleDescription(/Must be 0 or higher/);
    await expect(quantity).toHaveValue('-3');

    // Label/help/error wiring only — shared cf-card slate-500 chrome contrast is
    // out of scope for the quantity Field contract (same carve-out as #777/#886).
    const accessibilityScan = await new AxeBuilder({ page })
      .include('[data-testid="inventory-add-item"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await quantity.fill('2');
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/v1/campaigns/${campaignId}/inventory`) &&
          res.request().method() === 'POST',
      ),
      form.getByRole('button', { name: 'Add' }).click(),
    ]);
    expect(response.status()).toBe(201);
    await expect(form).toBeHidden();
    await expect(page.getByText('Labeled torch')).toBeVisible();
  });
});
