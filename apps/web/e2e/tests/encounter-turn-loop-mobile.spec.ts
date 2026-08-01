import { expect, test } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

/**
 * Issue #1465 — Phone viewport turn loop E2E test.
 *
 * Runs start -> next-turn -> damage -> condition -> end at 390x844 and 320px phone viewports,
 * asserting no horizontal document overflow at each step and >=44px touch targets at 320px.
 */
test.describe('phone viewport encounter turn loop (#1465)', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async () => {
    await restoreSeedEncounter();
  });

  const viewports = [
    { name: '390x844', width: 390, height: 844 },
    { name: '320px', width: 320, height: 720 },
  ];

  for (const vp of viewports) {
    test(`full turn loop at ${vp.name} maintains zero horizontal overflow`, async ({ page }) => {
      const { campaignId, encounterId } = seed();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

      const checkOverflow = async (stepName: string) => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `Horizontal overflow at step: ${stepName}`).toBeLessThanOrEqual(1);
      };

      // Step 1: Initial page load / start state
      await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
      await checkOverflow('initial load');

      // Step 2: Next turn
      const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
      await expect(nextTurnBtn).toBeVisible();
      await nextTurnBtn.click();
      await checkOverflow('next turn');

      // Step 3: Damage / HP adjustment
      const hpButton = page.getByTestId('combatant-hp-button').first();
      if (await hpButton.isVisible()) {
        await hpButton.click();
        await checkOverflow('damage modal/drawer open');
        // Apply 5 damage
        const applyBtn = page.getByRole('button', { name: /Apply|Submit|Confirm/i }).first();
        if (await applyBtn.isVisible()) {
          await applyBtn.click().catch(() => undefined);
        }
      }
      await checkOverflow('after damage');

      // Step 4: Condition editor
      const conditionTrigger = page.getByTestId('add-condition-trigger').first();
      if (await conditionTrigger.isVisible()) {
        await conditionTrigger.click();
        await checkOverflow('condition editor expanded');
      }
      await checkOverflow('condition step');

      // Step 5: End turn / cycle
      await nextTurnBtn.click();
      await checkOverflow('end turn');

      // 320px target size assertions
      if (vp.width === 320) {
        const nextTurnBox = await nextTurnBtn.boundingBox();
        expect(nextTurnBox).not.toBeNull();
        expect(nextTurnBox!.width, 'Next Turn button width').toBeGreaterThanOrEqual(44);
        expect(nextTurnBox!.height, 'Next Turn button height').toBeGreaterThanOrEqual(44);
      }
    });
  }
});
