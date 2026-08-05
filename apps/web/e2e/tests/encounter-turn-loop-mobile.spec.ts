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

  // This suite is serial (playwright.config.ts: fullyParallel: false, workers: 1) with one
  // shared seeded fixture. Each viewport case below advances the turn twice and applies
  // damage to a seed combatant; without restoring afterwards, later specs in file order
  // would inherit a damaged, mid-turn fight instead of the pristine seed state they expect.
  test.afterEach(async () => {
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

      // Step 2: Next turn. `click()` only awaits the DOM dispatch, not the mutation
      // round-trip + re-render, so an overflow check right after it can still measure the
      // pre-advance layout — wait for the `/next-turn` response first (matching the settle
      // discipline the damage/condition steps below already use).
      const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
      await expect(nextTurnBtn).toBeVisible();
      const [nextTurnResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/next-turn') && res.request().method() === 'POST',
        ),
        nextTurnBtn.click(),
      ]);
      expect(nextTurnResponse.ok(), 'next-turn click must advance the turn').toBe(true);
      await checkOverflow('next turn');

      // Step 3: Damage / HP adjustment. The real control is the `hp-steppers` group
      // (CombatantRow.tsx) — `combatant-hp-button` does not exist anywhere in the app, so
      // this step is required visible (not isVisible()-guarded) and its click is confirmed
      // via the PATCH response, so a broken HP control fails the test instead of silently
      // skipping the step.
      const hpSteppers = page.getByTestId('hp-steppers').first();
      await expect(hpSteppers).toBeVisible();
      const reduceHpBtn = hpSteppers.getByRole('button', { name: /Reduce/ }).first();
      await expect(reduceHpBtn).toBeVisible();
      const [hpPatchResponse] = await Promise.all([
        page.waitForResponse(
          (res) => /\/combatants\/\d+$/.test(new URL(res.url()).pathname) && res.request().method() === 'PATCH',
        ),
        reduceHpBtn.click(),
      ]);
      expect(hpPatchResponse.ok(), 'HP stepper click must apply the damage').toBe(true);
      await checkOverflow('after damage');

      // Step 4: Condition editor. The real toggle is `add-condition-toggle-${combatantId}`
      // (CombatantRow.tsx) — `add-condition-trigger` does not exist anywhere in the app.
      // Clicking it first opens a compact "Quick condition" picker (suggestion chips +
      // "More options…"), NOT the full form directly — confirmed against a live browser run
      // (the original `input[id^="condition-name-"]` assertion here failed in CI because
      // that input only mounts after "More options…" is clicked). The full, ten-control form
      // is exactly the overflow-prone UI issue #1465 calls out, so click through to it.
      const conditionTrigger = page.locator('[data-testid^="add-condition-toggle-"]').first();
      await expect(conditionTrigger).toBeVisible();
      await conditionTrigger.click();
      const moreOptionsBtn = page.getByRole('button', { name: 'More options…' });
      await expect(moreOptionsBtn).toBeVisible();
      await checkOverflow('quick condition picker expanded');
      await moreOptionsBtn.click();
      // Confirm the full condition form actually expanded before checking overflow.
      await expect(page.locator('input[id^="condition-name-"]').first()).toBeVisible();
      await checkOverflow('condition editor expanded');

      // Step 5: End turn / cycle — same settle discipline as Step 2 above.
      const [endTurnResponse] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/next-turn') && res.request().method() === 'POST',
        ),
        nextTurnBtn.click(),
      ]);
      expect(endTurnResponse.ok(), 'end-turn click must advance the turn').toBe(true);
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
