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

    try {
      // This 13th Age campaign/encounter is seeded once in global-setup.ts and is never
      // reset by restoreSeedEncounter (seed.ts, which only touches the main campaign's
      // fixture). CI retries once (playwright.config.ts) and local runs reuse the server,
      // so a rerun could start with the override already applied from a prior attempt —
      // require the pre-click state to differ from the value about to be set, so the final
      // assertion can only pass if this click genuinely changed something.
      await expect(panel).not.toContainText('+4');

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
    } finally {
      // Clear the override so a CI retry or a later run of this spec starts from the
      // un-overridden state instead of inheriting +4. `click()` alone only dispatches
      // the mutation (escalationControl.mutate({ override: null }) -> POST .../escalation
      // in RunSessionPage.tsx) — it does not wait for the request or the refetch that
      // updates the panel's text. If the test ends (and the page/context tears down)
      // before that round-trip finishes, a slow or cancelled cleanup could leave the
      // shared Archmage fixture at +4 for the next run, which never touches
      // restoreSeedEncounter(). Wait for the actual response and assert the panel
      // reflects the clear before letting the test finish.
      const clearBtn = panel.getByRole('button', { name: 'Clear' });
      if (await clearBtn.isVisible().catch(() => false)) {
        const [clearResponse] = await Promise.all([
          page.waitForResponse(
            (res) => res.url().includes('/escalation') && res.request().method() === 'POST',
          ),
          clearBtn.click(),
        ]);
        expect(clearResponse.ok(), 'clearing the escalation override must succeed').toBe(true);
        await expect(panel).not.toContainText('+4');
      }
    }
  });
});
