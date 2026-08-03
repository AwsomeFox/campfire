import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';
import { MAIN_CONTENT_ID, SKIP_TO_MAIN_ID } from '../../src/app/routeFocus';

/**
 * Milliseconds used to override the production recovery window for these specs (see
 * `routeFocus.ts`'s `graceMs` option and `RouteChangeFocus.tsx`'s e2e bridge). The real
 * window is `API_READ_BUDGET.overallMs` (tens of seconds) — a flat multi-second constant
 * that can only be exercised by actually waiting it out is effectively untested in CI,
 * which is how the boundary would silently rot later (review finding: coordinator). A
 * small injected value lets both sides of the boundary — inside the window, and after it
 * — run in well under a second instead.
 */
const TEST_GRACE_MS = 300;

/**
 * Seeds `window.__CAMPFIRE_E2E__.routeFocusGraceMs` before the app loads, gated the same
 * way as the Announcer e2e bridge (issue #434): read only under `navigator.webdriver`,
 * never in normal production browsing.
 */
async function installGraceMsOverride(page: Page, graceMs: number) {
  await page.addInitScript((ms) => {
    const w = window as Window & { __CAMPFIRE_E2E__?: { routeFocusGraceMs?: number } };
    if (typeof w.__CAMPFIRE_E2E__ !== 'object' || w.__CAMPFIRE_E2E__ == null) {
      w.__CAMPFIRE_E2E__ = {};
    }
    w.__CAMPFIRE_E2E__.routeFocusGraceMs = ms;
  }, graceMs);
}

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
  await installGraceMsOverride(page, TEST_GRACE_MS);

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

  // Release comfortably inside the injected recovery window — this is the case the fix
  // exists for: a supported (not failing) slow read whose heading arrives after the fallback
  // has already settled must still claim focus.
  await page.waitForTimeout(TEST_GRACE_MS / 3);
  releaseSummary();

  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeFocused();
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
  await installGraceMsOverride(page, TEST_GRACE_MS);

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

  // Let the injected focus-recovery window (armed for double the override — see
  // `settleOnTarget`'s arm site) fully elapse without ever releasing the summary — the same
  // watcher lifetime a route that never renders an h1 at all relies on to stop moving focus
  // forever (PR #1957 review, Devin and Copilot findings). A real wall-clock wait is
  // unavoidable here: the behavior under test is itself wall-clock-bounded, so there is no
  // faster observable event to wait on instead — but overriding the window down to
  // `TEST_GRACE_MS` keeps that wait well under a second instead of needing the real
  // multi-second production budget.
  await page.waitForTimeout(TEST_GRACE_MS * 2 + 200);

  // Only now does the real heading show up — after the focus-recovery window already closed.
  releaseSummary();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E — Cinderhaven' })).toBeVisible();

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  // Focus stays put — but title-sync is a separate, longer-lived concern (see
  // `teardownFallbackWatch`'s doc comment) and must still have updated to the real heading.
  await expect(main).toBeFocused();
  await expect(page).toHaveTitle(/E2E — Cinderhaven/);
});
