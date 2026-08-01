import { expect, test } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

/**
 * Issue #1465 — Encounter API error paths E2E test.
 *
 * Verifies that when encounter API endpoints fulfill 403, 409, or 500 errors,
 * the UI renders an actionable error note banner and controls re-enable.
 */
test.describe('encounter API error paths (#1465)', () => {
  test.use({ storageState: stateFor('dm') });

  test.beforeEach(async () => {
    await restoreSeedEncounter();
  });

  test('displays actionable error banner on 403 ENCOUNTER_IMMUTABLE and re-enables controls', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurnBtn).toBeEnabled();

    // Mock 403 Forbidden
    await page.route(`**/api/v1/encounters/${encounterId}/next-turn`, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 403,
          code: 'ENCOUNTER_IMMUTABLE',
          message: 'Encounter is archived and immutable',
        }),
      });
    });

    await nextTurnBtn.click();

    const errorNote = page.getByTestId('error-note');
    await expect(errorNote).toBeVisible();
    await expect(errorNote).toContainText(/archived|immutable|forbidden/i);

    // Control must re-enable afterwards
    await expect(nextTurnBtn).toBeEnabled();
  });

  test('displays actionable error banner on 409 ENCOUNTER_ALREADY_RUNNING and re-enables controls', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurnBtn).toBeEnabled();

    // Mock 409 Conflict
    await page.route(`**/api/v1/encounters/${encounterId}/next-turn`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 409,
          code: 'ENCOUNTER_ALREADY_RUNNING',
          message: 'Another encounter is currently running in this campaign.',
        }),
      });
    });

    await nextTurnBtn.click();

    const errorNote = page.getByTestId('error-note');
    await expect(errorNote).toBeVisible();
    await expect(errorNote).toContainText(/running|conflict/i);

    await expect(nextTurnBtn).toBeEnabled();
  });

  test('displays actionable error banner on 500 STALE_WRITE server error and re-enables controls', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const nextTurnBtn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurnBtn).toBeEnabled();

    // Mock 500 Internal Server Error
    await page.route(`**/api/v1/encounters/${encounterId}/next-turn`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 500,
          code: 'STALE_WRITE',
          message: 'Internal server error while writing turn state.',
        }),
      });
    });

    await nextTurnBtn.click();

    const errorNote = page.getByTestId('error-note');
    await expect(errorNote).toBeVisible();

    await expect(nextTurnBtn).toBeEnabled();
  });
});
