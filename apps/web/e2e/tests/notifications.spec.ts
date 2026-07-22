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
    const bell = page.getByRole('button', { name: 'Notifications (2 unread)' });
    await expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(bell).toHaveAttribute('aria-expanded', 'false');

    await bell.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    const markAllRead = dialog.getByRole('button', { name: 'Mark all read' });
    const firstItem = dialog.getByRole('button', { name: /The western road changed/ });
    const lastItem = dialog.getByRole('button', { name: /The eastern road changed/ });

    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription('2 items.');
    await expect(dialog.getByRole('status')).toHaveText('2 items.');
    await expect(markAllRead).toBeFocused();
    await expect(bell).toHaveAttribute('aria-expanded', 'true');
    const controlledId = await bell.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    await expect(dialog).toHaveAttribute('id', controlledId!);
    await expect.poll(() => bell.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);

    await page.keyboard.press('Tab');
    await expect(firstItem).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(lastItem).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(markAllRead).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(lastItem).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();
    await expect(bell).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => bell.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);
  });

  test('keeps the empty dialog focus-safe and dismissible at a mobile viewport', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 375, height: 667 });
    await page.route(COUNT_URL, (route) => route.fulfill({ json: { count: 0 } }));
    await page.route(LIST_URL, (route) => route.fulfill({ json: [] }));

    await page.goto(`/c/${campaignId}`);
    const bell = page.getByRole('button', { name: 'Notifications', exact: true });
    await bell.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog).toHaveAccessibleDescription('0 items.');
    await expect(dialog.getByRole('status')).toHaveText('0 items.');
    await expect(dialog.getByText('Nothing yet')).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(12);
    expect(box!.x + box!.width).toBeLessThanOrEqual(363);
    expect(box!.y).toBeGreaterThanOrEqual(12);
    expect(box!.y + box!.height).toBeLessThanOrEqual(655);

    await page.keyboard.press('Tab');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();

    await bell.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await expect(bell).toBeFocused();
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
  await expect.poll(() => countRequests).toBe(2);
  await expect.poll(() => activeRequests).toBe(0);
  expect(maxActiveRequests).toBe(1);

  await first.getByRole('button', { name: /Notifications/ }).click();
  await first.getByRole('button', { name: 'Shared tab notification' }).click();
  await expect(second.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await expect(second.getByRole('button', { name: /unread/ })).toHaveCount(0);

  await context.close();
});
