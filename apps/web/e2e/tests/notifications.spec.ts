import AxeBuilder from '@axe-core/playwright';
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { Notification } from '@campfire/schema';
import { seed, stateFor } from './seed';

const COUNT_URL = '**/api/v1/notifications/unread-count';
const LIST_URL = '**/api/v1/notifications?limit=30';

function notification(title: string, id: number): Notification {
  const { campaignId, navigation } = seed();
  return {
    id,
    userId: 3,
    campaignId,
    type: 'quest_updated',
    title,
    body: 'The road ahead has changed.',
    entityType: 'quest',
    entityId: navigation.questId,
    commentId: null,
    data: null,
    actorName: 'Dungeon Master',
    readAt: null,
    createdAt: new Date().toISOString(),
  };
}

async function closePanelFromBackdrop(page: Page) {
  await page.getByRole('dialog', { name: 'Notifications' }).evaluate((dialog) => {
    (dialog.parentElement as HTMLElement).click();
  });
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toHaveCount(0);
}

test.describe('shared notification controller', () => {
  test.use({ storageState: stateFor('player'), serviceWorkers: 'block' });

  test('is a named modal with an accurate item announcement and complete keyboard dismissal', async ({ page }) => {
    const { campaignId } = seed();
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 2 } }));
    await page.route(LIST_URL, (route) => route.fulfill({
      json: [
        notification('The western road changed', 9891),
        notification('The eastern road changed', 9892),
      ],
    }));

    await page.goto(`/c/${campaignId}`);
    // See mobile empty-dialog test — wait out RouteChangeFocus's deferred route heading focus.
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    const bell = page.getByRole('button', { name: 'Notifications (2 unread)' });
    await expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(bell).toHaveAttribute('aria-expanded', 'false');
    await expect(bell).not.toHaveAttribute('aria-controls');

    await bell.focus();
    await expect(bell).toBeFocused();
    await bell.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    const markDisplayedRead = dialog.getByRole('button', { name: 'Mark displayed (2) read' });
    const markCampaignRead = dialog.getByRole('button', { name: 'Mark campaign read' });
    const firstItem = dialog.getByRole('button', { name: /The western road changed/ });
    const lastItem = dialog.getByRole('button', { name: /The eastern road changed/ });

    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription('2 items.');
    await expect(dialog.locator('span[role="status"]')).toHaveText('2 items.');
    await expect(markDisplayedRead).toBeFocused();
    await expect(bell).toHaveAttribute('aria-expanded', 'true');
    const controlledId = await bell.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    await expect(dialog).toHaveAttribute('id', controlledId!);
    await expect.poll(() => bell.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);

    // Focus cycle: Mark displayed -> Mark campaign -> Close -> items -> wrap.
    const closeButton = dialog.getByRole('button', { name: 'Close notifications' });
    await page.keyboard.press('Tab');
    await expect(markCampaignRead).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(firstItem).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(lastItem).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(markDisplayedRead).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(lastItem).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();
    await expect(bell).toHaveAttribute('aria-expanded', 'false');
    await expect(bell).not.toHaveAttribute('aria-controls');
    await expect.poll(() => bell.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);
  });

  test('keeps the empty dialog focus-safe and dismissible at a mobile viewport', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 375, height: 667 });
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 0 } }));
    await page.route(LIST_URL, (route) => route.fulfill({ json: [] }));

    await page.goto(`/c/${campaignId}`);
    // Dashboard exposes a route h1 (#1711), so RouteChangeFocus lands on the h1 via rAF.
    // Wait for that settle before focusing the bell — otherwise the deferred
    // focus steal leaves Enter landing outside the trigger (issue #591).
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    const bell = page.getByRole('button', { name: 'Notifications', exact: true });
    await expect(bell).toBeVisible();
    await bell.focus();
    await expect(bell).toBeFocused();
    await bell.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription('0 items.');
    await expect(dialog.locator('span[role="status"]')).toHaveText('0 items.');
    await expect(dialog.getByText('Nothing yet')).toBeVisible();

    // Issue #664: the panel is a bottom sheet on narrow viewports, so it hugs
    // the bottom edge and spans the viewport width (matching the MoreSheet).
    const closeButton = dialog.getByRole('button', { name: 'Close notifications' });
    await expect(closeButton).toBeVisible();
    await expect(closeButton).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(375);
    expect(box!.y + box!.height).toBe(667);

    // With only the close button focusable, Tab wraps back to it.
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(closeButton).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();

    await bell.click();
    await expect(dialog).toBeVisible();
    // The visible close button is itself a dismiss affordance on mobile.
    await closeButton.click();
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();
  });

  test('announces the same notification load failure that it displays', async ({ page }) => {
    const { campaignId } = seed();
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 0 } }));
    await page.route(LIST_URL, (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog.getByRole('alert')).toHaveText(/Couldn't load notifications\./);
    // Dialog description stays neutral; ErrorNote owns the failure alert (#592).
    await expect(dialog).toHaveAccessibleDescription('Notification list unavailable.');
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('retries a failed notification list load from the dialog', async ({ page }) => {
    const { campaignId } = seed();
    let listRequests = 0;
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 1 } }));
    await page.route(LIST_URL, async (route) => {
      listRequests += 1;
      if (listRequests === 1) {
        await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
        return;
      }
      await route.fulfill({ json: [notification('Recovered notification', 9920)] });
    });

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.getByRole('button', { name: 'Recovered notification' })).toBeVisible();
    await expect(dialog.locator('span[role="status"]')).toHaveText('1 item.');
    expect(listRequests).toBe(2);
  });

  test('announces mark displayed read in the dialog status region', async ({ page }) => {
    const { campaignId } = seed();
    let unreadCount = 2;
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: unreadCount } }));
    await page.route(LIST_URL, (route) => route.fulfill({
      json: [
        notification('First unread', 9921),
        notification('Second unread', 9922),
      ],
    }));
    await page.route('**/api/v1/notifications/mark-read', async (route) => {
      unreadCount = 0;
      await route.fulfill({ json: { updated: 2, updatedIds: [9921, 9922] } });
    });

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Notifications (2 unread)' }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog.locator('span[role="status"]')).toHaveText('2 items.');
    await dialog.getByRole('button', { name: 'Mark displayed (2) read' }).click();
    await expect(dialog.locator('span[role="status"]')).toHaveText('Marked 2 displayed notifications as read.');
    // Trigger sits under inert background while the dialog is open.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  });

  test('confirms mark all read when undisplayed rows exist', async ({ page }) => {
    const { campaignId } = seed();
    const items30 = Array.from({ length: 30 }, (_, index) => notification(`Notice ${index + 1}`, 9800 + index));
    let unreadCount = 35;
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: unreadCount } }));
    await page.route(LIST_URL, (route) => route.fulfill({ json: items30 }));
    await page.route('**/api/v1/notifications/mark-read', async (route) => {
      const body = route.request().postDataJSON() as { all?: boolean };
      if (body.all) {
        const undisplayedIds = [9770, 9771, 9772, 9773, 9774];
        const updatedIds = [...items30.map((item) => item.id), ...undisplayedIds];
        unreadCount = 0;
        await route.fulfill({ json: { updated: updatedIds.length, updatedIds } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Notifications (35 unread)' }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await dialog.getByRole('button', { name: 'Mark all (35) read' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Mark all 35 notifications as read?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Mark all 35 read' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.locator('span[role="status"]')).toHaveText('All notifications marked as read.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  });

  test('announces mark all read failure in the dialog status region', async ({ page }) => {
    const { campaignId } = seed();
    const items30 = Array.from({ length: 30 }, (_, index) => notification(`Notice ${index + 1}`, 9800 + index));
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 35 } }));
    await page.route(LIST_URL, (route) => route.fulfill({ json: items30 }));
    await page.route('**/api/v1/notifications/mark-read', async (route) => {
      const body = route.request().postDataJSON() as { all?: boolean };
      if (body.all) {
        await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Notifications (35 unread)' }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog.locator('span[role="status"]')).toHaveText('30 items.');
    await dialog.getByRole('button', { name: 'Mark all (35) read' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Mark all 35 notifications as read?' });
    await confirm.getByRole('button', { name: 'Mark all 35 read' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.locator('span[role="status"]')).toHaveText("Couldn't mark all notifications as read.");
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Notifications (35 unread)' })).toBeVisible();
  });

  test('announces loading before items arrive', async ({ page }) => {
    const { campaignId } = seed();
    let releaseList: () => void = () => {};
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 0 } }));
    await page.route(LIST_URL, async (route) => {
      await listGate;
      await route.fulfill({ json: [] });
    });

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog.locator('span[role="status"]')).toHaveText('Loading items.');
    releaseList();
    await expect(dialog.locator('span[role="status"]')).toHaveText('0 items.');
  });

  test('reflows and scrolls at the 200% zoom equivalent on desktop', async ({ page }) => {
    const { campaignId } = seed();
    // 640 CSS pixels is the reflow width for a 1280px layout at 200% browser zoom.
    await page.setViewportSize({ width: 640, height: 480 });
    const many = Array.from({ length: 24 }, (_, index) => notification(`Notice ${index + 1}`, 9930 + index));
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: many.length } }));
    await page.route(LIST_URL, (route) => route.fulfill({ json: many }));

    await page.goto(`/c/${campaignId}`);
    await page.getByRole('button', { name: new RegExp(`Notifications \\(${many.length} unread\\)`) }).click();

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(640 + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);

    const scrollRegion = dialog.locator('.overflow-y-auto');
    await expect(scrollRegion).toBeVisible();
    const beforeScroll = await scrollRegion.evaluate((element) => element.scrollTop);
    await scrollRegion.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeScroll);
    await expect(dialog.getByRole('button', { name: 'Notice 24' })).toBeVisible();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('renders one responsive bell and does not overlap route refreshes', async ({ page }) => {
    const { campaignId } = seed();
    let requests = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let delayMs = 0;

    await page.route(COUNT_URL, async (route) => {
      requests += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ json: { count: 2 } });
      activeRequests -= 1;
    });
    await page.route(LIST_URL, (route) => route.fulfill({ json: [] }));

    await page.goto(`/c/${campaignId}`);
    await expect(page.getByRole('button', { name: 'Notifications (2 unread)' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Notifications/ })).toHaveCount(1);
    expect(requests).toBe(1);

    const bell = page.getByRole('button', { name: /Notifications/ });
    await bell.focus();
    await bell.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();

    await bell.click();
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('button', { name: /Notifications/ })).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    expect(requests).toBe(1);
    await closePanelFromBackdrop(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    delayMs = 200;
    await page.getByRole('link', { name: 'Quests', exact: true }).click();
    await expect.poll(() => activeRequests).toBe(1);
    await page.getByRole('link', { name: 'Party' }).click();
    await expect(page).toHaveURL(`/c/${campaignId}/party`);
    await expect.poll(() => activeRequests).toBe(0);

    expect(requests).toBe(2);
    expect(maxActiveRequests).toBe(1);
    await expect(page.getByRole('button', { name: /Notifications/ })).toHaveCount(1);
  });

  test('pauses while hidden or offline and refreshes once on each restore', async ({ page, context }) => {
    const { campaignId } = seed();
    let requests = 0;
    await page.clock.install();
    await page.route(COUNT_URL, async (route) => {
      requests += 1;
      await route.fulfill({ json: { count: requests } });
    });

    await page.goto(`/c/${campaignId}`);
    await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
    expect(requests).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(120_000);
    expect(requests).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      // A duplicate browser event must not cause a duplicate restore request.
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('button', { name: 'Notifications (2 unread)' })).toBeVisible();
    expect(requests).toBe(2);

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.clock.fastForward(120_000);
    expect(requests).toBe(2);

    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Notifications (3 unread)' })).toBeVisible();
    expect(requests).toBe(3);
  });

  test('cancels obsolete panel loads and preserves mark-read navigation across a breakpoint', async ({ page }) => {
    const { campaignId, navigation } = seed();
    let unreadCount = 1;
    let listRequests = 0;
    let readRequests = 0;
    let releaseObsolete: () => void = () => {};
    const obsoleteGate = new Promise<void>((resolve) => {
      releaseObsolete = resolve;
    });

    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: unreadCount } }));
    await page.route(LIST_URL, async (route) => {
      listRequests += 1;
      if (listRequests === 1) {
        await obsoleteGate;
        await route.fulfill({ json: [notification('Obsolete notification', 9901)] }).catch(() => {});
        return;
      }
      await route.fulfill({ json: [notification('Fresh notification', 9902)] });
    });
    await page.route('**/api/v1/notifications/9902/read', async (route) => {
      readRequests += 1;
      unreadCount = 0;
      await route.fulfill({ json: { ...notification('Fresh notification', 9902), readAt: new Date().toISOString() } });
    });

    await page.goto(`/c/${campaignId}`);
    await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await expect.poll(() => listRequests).toBe(1);
    await closePanelFromBackdrop(page);

    await page.getByRole('button', { name: /Notifications/ }).click();
    await expect(page.getByRole('button', { name: 'Fresh notification' })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Notifications/ })).toHaveCount(1);

    releaseObsolete();
    await expect(page.getByRole('button', { name: 'Obsolete notification' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Fresh notification' }).click();

    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/quests/${navigation.questId}#entity-quest-${navigation.questId}$`));
    expect(readRequests).toBe(1);
    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  });
});

test('coordinates polling and read state between tabs', async ({ browser }) => {
  const { campaignId } = seed();
  const context: BrowserContext = await browser.newContext({
    storageState: stateFor('player'),
    serviceWorkers: 'block',
  });
  let unreadCount = 1;
  let countRequests = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;

  await context.route(COUNT_URL, async (route: Route) => {
    countRequests += 1;
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ json: { count: unreadCount } });
    activeRequests -= 1;
  });
  await context.route(LIST_URL, (route) => route.fulfill({ json: [notification('Shared tab notification', 9910)] }));
  await context.route('**/api/v1/notifications/9910/read', async (route) => {
    unreadCount = 0;
    await route.fulfill({ json: { ...notification('Shared tab notification', 9910), readAt: new Date().toISOString() } });
  });

  const first = await context.newPage();
  await first.goto(`/c/${campaignId}`);
  await expect(first.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
  expect(countRequests).toBe(1);

  const second = await context.newPage();
  await second.goto(`/c/${campaignId}`);
  await expect(second.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
  await second.waitForTimeout(100);
  expect(countRequests).toBe(1);

  await Promise.all([
    first.getByRole('link', { name: 'Quests', exact: true }).click(),
    second.getByRole('link', { name: 'Quests', exact: true }).click(),
  ]);
  await expect.poll(() => countRequests, { timeout: 25000 }).toBe(2);
  await expect.poll(() => activeRequests, { timeout: 25000 }).toBe(0);
  expect(maxActiveRequests).toBe(1);

  await first.getByRole('button', { name: /Notifications/ }).click();
  await first.getByRole('button', { name: 'Shared tab notification' }).click();
  await expect(second.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await expect(second.getByRole('button', { name: /unread/ })).toHaveCount(0);

  await context.close();
});

test('restores a new unread count after mark-all-read across tabs', async ({ browser }) => {
  const { campaignId } = seed();
  const context: BrowserContext = await browser.newContext({
    storageState: stateFor('player'),
    serviceWorkers: 'block',
  });
  let unreadCount = 2;
  const item = notification('A newly arrived recap', 9911);
  let holdNextCount = false;
  let staleCountStarted = false;
  let releaseStaleCount: () => void = () => {};
  const staleCount = new Promise<void>((resolve) => {
    releaseStaleCount = resolve;
  });

  await context.route(COUNT_URL, async (route: Route) => {
    const countAtRequest = unreadCount;
    if (holdNextCount) {
      holdNextCount = false;
      staleCountStarted = true;
      await staleCount;
    }
    await route.fulfill({ json: { count: countAtRequest } });
  });
  await context.route(LIST_URL, (route) => route.fulfill({ json: [item] }));
  await context.route('**/api/v1/notifications/mark-read', async (route: Route) => {
    const body = route.request().postDataJSON() as { all?: boolean };
    if (body.all) unreadCount = 0;
    await route.fulfill({ json: { updated: 1, updatedIds: [item.id] } });
  });

  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto(`/c/${campaignId}`);
  await second.goto(`/c/${campaignId}`);
  await expect(first.getByRole('button', { name: 'Notifications (2 unread)' })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Notifications (2 unread)' })).toBeVisible();

  // Start a count load before read-all in the other tab, then release its stale
  // positive response after the read-all broadcast arrives.
  holdNextCount = true;
  await second.bringToFront();
  void second.getByRole('link', { name: 'Quests', exact: true }).click();
  await expect.poll(() => staleCountStarted, { timeout: 25000 }).toBe(true);
  await first.getByRole('button', { name: /Notifications/ }).click();
  await first.getByRole('button', { name: 'Mark all (2) read' }).click();
  const confirm = first.getByRole('dialog').filter({ hasText: 'Mark all 2 notifications as read?' });
  await confirm.getByRole('button', { name: 'Mark all 2 read' }).click();
  await expect(first.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  releaseStaleCount();
  await expect(second.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  // A second tab's new count request starts after read-all, so its positive
  // response is fresh server evidence rather than the released stale request.
  unreadCount = 1;
  await second.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();

  await context.close();
});

test.describe('Issue #550: Notification Center, pagination, confirmation, and undo', () => {
  test.use({ storageState: stateFor('player'), serviceWorkers: 'block' });

  test('Notification Center renders 35 items with cursor pagination, filters, confirmation dialog, and undo', async ({ page }) => {
    const { campaignId } = seed();
    const items35 = Array.from({ length: 35 }, (_, index) => ({
      id: 1000 + index,
      userId: 3,
      campaignId,
      type: 'quest_updated' as const,
      title: `Quest notification ${index + 1}`,
      body: `Details for quest notification ${index + 1}`,
      entityType: 'quest' as const,
      entityId: 1,
      commentId: null,
      data: null,
      actorName: 'Dungeon Master',
      readAt: null,
      createdAt: new Date(Date.now() - index * 60000).toISOString(),
    }));

    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 35 } }));
    await page.route('**/api/v1/notifications?*', (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        return route.fulfill({
          json: {
            items: items35.slice(0, 30),
            nextCursor: items35[29].id,
            total: 35,
            hasMore: true,
          },
        });
      }
      return route.fulfill({
        json: {
          items: items35.slice(30),
          nextCursor: null,
          total: 35,
          hasMore: false,
        },
      });
    });

    await page.goto(`/c/${campaignId}/notifications`);
    await expect(page.getByRole('heading', { name: 'Notification Center' })).toBeVisible();
    await expect(page.getByText('Showing 30 notifications of 35')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more notifications' })).toBeVisible();

    // Test confirmation dialog when clicking "Mark all (35) read" with undisplayed rows
    await page.route('**/api/v1/notifications/mark-read', (route) => route.fulfill({
      json: { updated: 35, updatedIds: items35.map((n) => n.id) },
    }));

    await page.getByRole('button', { name: 'Mark all (35) read' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/including rows not currently displayed/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Mark all 35 read' }).click();
    await expect(dialog).toHaveCount(0);

    // Undo snackbar should be displayed
    const undoSnackbar = page.getByTestId('undo-snackbar');
    await expect(undoSnackbar).toBeVisible();
    await expect(undoSnackbar.getByText(/Marked 35 notifications as read/).first()).toBeVisible();

    // Test Undo
    await page.route('**/api/v1/notifications/mark-unread', (route) => route.fulfill({
      json: { updated: 35, updatedIds: items35.map((n) => n.id) },
    }));
    await undoSnackbar.getByRole('button', { name: 'Undo' }).click();
    await expect(undoSnackbar).toHaveCount(0);

    // Test cursor pagination (Load more)
    await page.getByRole('button', { name: 'Load more notifications' }).click();
    await expect(page.getByText('Showing 35 notifications')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more notifications' })).toHaveCount(0);
  });
});
