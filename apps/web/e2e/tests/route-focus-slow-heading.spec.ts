import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { FALLBACK_UPGRADE_GRACE_MS, MAIN_CONTENT_ID, SKIP_TO_MAIN_ID } from '../../src/app/routeFocus';

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
 *
 * A permanently-live recovery window has its own problems (see PR #1957 review), so
 * `focusMainDestination` bounds it to `FALLBACK_UPGRADE_GRACE_MS` and cancels it the moment
 * the user acts (a skip-link activation, a click, or a tab) rather than leaving focus
 * perpetually up for grabs. The two tests below cover those two edges: a late heading must
 * never claw focus back from a user who already moved on, and a heading arriving after the
 * grace window must not claw focus away either (bounding the watcher's lifetime the same way
 * a route that never renders an h1 at all would).
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

  // Wait on the observable outcome — the fallback has settled on <main> — instead of a fixed
  // sleep (issue #1954's anti-pattern): this both avoids flaking on slow runners and confirms
  // the gated summary really is racing the fallback rather than beating it.
  await expect(page.locator(`#${MAIN_CONTENT_ID}`)).toBeFocused();
  releaseSummary();

  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeFocused({ timeout: 5_000 });
});

test('a late heading does not claw focus back from a user who already activated the skip link (#591)', async ({
  page,
}) => {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}`);
  await expect(page.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Party', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Party' })).toBeFocused();

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

  // The fallback settles on <main> first, same as the test above.
  const main = page.locator(`#${MAIN_CONTENT_ID}`);
  await expect(main).toBeFocused();

  // The user explicitly reactivates the skip link before the real h1 shows up — landing
  // focus on the exact same <main> element the fallback already used, which is precisely
  // the case a plain `activeElement === main` check cannot tell apart from "untouched
  // fallback" (PR #1957 review, P2 codex finding).
  const skip = page.locator(`#${SKIP_TO_MAIN_ID}`);
  await skip.focus();
  await skip.click();
  await expect(main).toBeFocused();

  // Now let the real heading arrive. It must not steal focus away from the user's explicit
  // skip-link activation.
  releaseSummary();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeVisible();

  // Give the (buggy, pre-fix) late-upgrade path the two animation frames it schedules itself
  // on — mirroring `focusMainDestination`'s own `scheduleFrame` — rather than an arbitrary
  // sleep, then confirm focus is still exactly where the user put it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(main).toBeFocused();
});

test('a heading arriving after the recovery grace window does not claw focus away (#591)', async ({ page }) => {
  const { campaignId } = seed();
  await page.goto(`/c/${campaignId}`);
  await expect(page.getByText('Cinderhaven', { exact: false }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Party', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Party' })).toBeFocused();

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

  const main = page.locator(`#${MAIN_CONTENT_ID}`);
  await expect(main).toBeFocused();

  // Let the bounded recovery window fully elapse without ever releasing the summary — this is
  // the same watcher lifetime a route that never renders an h1 at all relies on to stop
  // re-running `publishTitle()` and watching for a heading forever (PR #1957 review, Devin and
  // Copilot findings). A real wall-clock wait is unavoidable here: the behavior under test is
  // itself wall-clock-bounded, so there is no faster observable event to wait on instead.
  await page.waitForTimeout(FALLBACK_UPGRADE_GRACE_MS + 500);

  // Only now does the real heading show up — after the recovery window already closed.
  releaseSummary();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeVisible();

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(main).toBeFocused();
});
