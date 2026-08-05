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

    // The override control is a plain-text `TextInput` (inputMode="numeric", no
    // `type="number"`) — RunSessionPage.tsx renders it with
    // `aria-label="Escalation die override"`. Require it visible (rather than
    // conditionally skipping) so a broken override control fails this test instead of
    // silently passing.
    const overrideInput = panel.getByLabel('Escalation die override');
    await expect(overrideInput).toBeVisible();
    await overrideInput.fill('4');
    await panel.getByRole('button', { name: 'Override' }).click();
    await expect(panel).toContainText('+4');
  });
});
