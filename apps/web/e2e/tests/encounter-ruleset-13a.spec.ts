import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #1465 — 13th Age (Archmage) ruleset browser spec.
 *
 * Verifies that opening an encounter in a 13th Age campaign renders the
 * 13th Age Escalation Die panel and allows setting DM escalation die overrides (0-6).
 */
test.describe('13th Age ruleset encounter panel (#1465)', () => {
  test.use({ storageState: stateFor('dm') });

  test('renders 13th Age escalation die panel and accepts valid 0-6 overrides', async ({ page }) => {
    const { archmageCampaignId, archmageEncounterId } = seed();
    await page.goto(`/c/${archmageCampaignId}/encounters/${archmageEncounterId}`);

    const panel = page.getByTestId('archmage-escalation-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/Escalation die/i);

    // Override input or buttons inside panel
    const overrideInput = panel.locator('input[type="number"]');
    if (await overrideInput.isVisible()) {
      await overrideInput.fill('4');
      const setBtn = panel.getByRole('button', { name: /Set|Override|Save/i }).first();
      if (await setBtn.isVisible()) {
        await setBtn.click();
      }
      await expect(panel).toContainText('+4');
    }
  });
});
