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
 * the user acts (a skip-link activation, a click, a tab, or a non-focus-moving key like an
 * arrow or PageDown) rather than leaving focus perpetually up for grabs. The tests below
 * cover those edges: a late heading must never claw focus back from a user who already moved
 * on — whether or not that action itself moved DOM focus — and a heading arriving after the
 * grace window must not claw focus away either (bounding the watcher's lifetime the same way
 * a route that never renders an h1 at all would).
 */
test.use({ storageState: stateFor('dm') });

test('back-navigation focus recovers onto a slow-to-render Dashboard heading (#591)', async ({ page }) => {
  // The grace window is now derived from API_READ_BUDGET.overallMs (30s) rather than an
  // arbitrary constant (review finding: P2 codex — a supported-but-slow read must still be
  // caught), and this test deliberately exercises a delay past the *previous* 5s bound to
  // prove the extended window is what makes that possible, so it needs more than the default
  // 30s Playwright test timeout.
  test.setTimeout(45_000);

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

  // Hold the response well past the OLD 5s grace window — this is the exact regression the
  // P2 codex finding identified: a supported (not failing) slow read that outlasts a too-short
  // window would previously have left focus stranded on <main> forever. A real wall-clock wait
  // is unavoidable here since the thing under test is itself wall-clock-bounded.
  await page.waitForTimeout(6_000);
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

test('a late heading does not claw focus away after a non-focus-moving key press (#591)', async ({ page }) => {
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

  // The fallback settles on <main> first, same as the tests above.
  const main = page.locator(`#${MAIN_CONTENT_ID}`);
  await expect(main).toBeFocused();

  // Arrow keys typically just scroll the page — DOM focus never moves off <main> — which is
  // exactly the gap a focus-change-only listener cannot see (PR #1957 review, P2 codex
  // finding): `document.activeElement` still reads as `main`, so a plain equality check would
  // let the late h1 steal focus even though the user has clearly moved on.
  await expect(main).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(main).toBeFocused();

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

test('a late heading does not steal focus from an open dialog (#591)', async ({ page }) => {
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

  // The fallback settles on <main> first, same as the tests above.
  const main = page.locator(`#${MAIN_CONTENT_ID}`);
  await expect(main).toBeFocused();

  // Open a real modal dialog (the shared notification panel) while the fallback is still
  // untouched and the recovery window is open. A dialog opening is not a "user takeover"
  // under `handleUserTookOver`'s predicate — it moves focus itself, the app didn't ask the
  // user to do anything — so this exercises the separate modal guard in `upgradeFromFallback`
  // rather than the focusin-based takeover tracking covered by the tests above.
  const bell = page.getByRole('button', { name: 'Notifications', exact: true });
  await bell.click();
  const dialog = page.getByRole('dialog', { name: 'Notifications' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.locator(':focus')).toHaveCount(1);

  // Now let the real heading arrive. It must not steal focus away from the open dialog.
  releaseSummary();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeVisible();

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
});

test('a heading arriving after the recovery grace window does not claw focus away (#591)', async ({ page }) => {
  // FALLBACK_UPGRADE_GRACE_MS is now API_READ_BUDGET.overallMs (30s), so waiting it out plus
  // margin needs more than the default 30s Playwright test timeout.
  test.setTimeout(60_000);

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
