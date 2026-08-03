import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #591 regression (found via PR #1950's CI on `layout-skip-nav-a11y.spec.ts:75`,
 * "browser back restores focus to the previous page destination").
 *
 * `focusMainDestination` (routeFocus.ts) waits only ~2 animation frames for an async h1
 * before giving up and settling focus on the stable `<main>` landmark instead — needed so a
 * genuinely headless list screen doesn't leave focus stranded on nav chrome for seconds. The
 * Dashboard renders nothing at all (no h1) until its `/campaigns/:id/summary` fetch resolves
 * (`DashboardPage.tsx`: `if (!summary) return null;`), so on a loaded/slow runner that fetch
 * can easily outlast those 2 frames even though the real h1 is only a little further behind.
 * Before this fix, giving up was PERMANENT: once settled on `<main>`, the MutationObserver
 * kept firing (title stayed in sync) but never re-attempted focus, so the real h1 — once it
 * did arrive — was simply never focused. This is reproduced deterministically here (no CPU
 * throttling, no timing luck) by gating the summary response well past that 2-frame window;
 * it does not touch the existing `layout-skip-nav-a11y.spec.ts` file or weaken any of its
 * assertions.
 */
test.use({ storageState: stateFor('dm') });

test('back-navigation focus recovers onto a slow-to-render Dashboard heading (#591)', async ({ page }) => {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}`);
  await expect(page.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Party', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Party' })).toBeFocused();

  // Gate the Dashboard's summary fetch AFTER the initial load (already satisfied above) so
  // only the upcoming back-navigation's re-fetch is delayed.
  let releaseSummary: () => void = () => {};
  const summaryGate = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  await page.route(`**/api/v1/campaigns/${campaignId}/summary`, async (route) => {
    await summaryGate;
    await route.continue();
  });

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/c/${campaignId}$`));

  // Give the fallback a comfortable margin past its ~2-frame window to give up and settle
  // on <main> before the gated summary (and therefore the real h1) arrives.
  await page.waitForTimeout(200);
  releaseSummary();

  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeFocused({ timeout: 5_000 });
});
