/**
 * Slow-network skeleton visibility (issue #677).
 *
 * Visual regression against the live SPA: delayed auxiliary endpoints must
 * render geometry-preserving skeletons (not blank/null) while data is in flight.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

test.describe('loading skeleton slow-network surfaces (issue #677)', () => {
  test('sessions attendance shows a skeleton while attendance is delayed', async ({ page }) => {
    const { campaignId, navigation } = seed();
    let releaseAttendance: () => void = () => {};
    const attendanceGate = new Promise<void>((resolve) => {
      releaseAttendance = resolve;
    });

    await page.route('**/api/v1/sessions/*/attendance', async (route) => {
      await attendanceGate;
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
    await expect(page.getByRole('heading', { name: 'DLRNAV First Crossing' })).toBeVisible();

    const attendanceSkeleton = page.locator(
      '[data-testid="skeleton-conditional-region"][data-skeleton-preset="attendance"] [role="status"]',
    );
    await expect(attendanceSkeleton).toBeVisible();

    releaseAttendance();
    await expect(attendanceSkeleton).toBeHidden({ timeout: 15_000 });
  });

  test('campaign settings AI card shows a card skeleton while AI DM settings are delayed', async ({ page }) => {
    const { campaignId } = seed();
    let releaseAiDm: () => void = () => {};
    const aiDmGate = new Promise<void>((resolve) => {
      releaseAiDm = resolve;
    });

    await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm`, async (route) => {
      await aiDmGate;
      await route.continue();
    });
    await page.route(`**/api/v1/campaigns/${campaignId}/ai-provider/effective`, async (route) => {
      await aiDmGate;
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/settings#ai-dm`);
    const cardSkeleton = page.locator('[data-testid="skeleton-card"] [role="status"]');
    await expect(cardSkeleton).toBeVisible();

    releaseAiDm();
    await expect(cardSkeleton).toBeHidden({ timeout: 15_000 });
  });

  test('character detail shows a named skeleton while the sheet is delayed', async ({ page }) => {
    const { campaignId, navigation } = seed();
    let releaseCharacter: () => void = () => {};
    const characterGate = new Promise<void>((resolve) => {
      releaseCharacter = resolve;
    });

    await page.route(`**/api/v1/characters/${navigation.characterId}`, async (route) => {
      await characterGate;
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const loading = page.getByTestId('character-detail-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    await expect(loading).toHaveAttribute('aria-label', 'Loading character…');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);

    releaseCharacter();
    await expect(loading).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('character detail distinguishes not-found from the loading shell', async ({ page }) => {
    const { campaignId } = seed();

    await page.goto(`/c/${campaignId}/characters/999999999`);
    await expect(page.getByTestId('character-detail-loading')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('Character not found')).toBeVisible();
  });
});
