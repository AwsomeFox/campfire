import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Quest + Location status picker accessibility (issue #705).
 *
 * Both detail pages previously rendered a plain absolute <div> popover for the
 * DM "set status" control with no popup semantics, selected state, focus
 * movement, Escape/outside dismissal, or keyboard navigation. These specs lock
 * in the shared accessible listbox pattern: expanded/controls/selected state,
 * arrow / Home / End / Enter / Space / Escape / Tab keyboard contract, focus
 * restoration, outside-click dismissal, reflow at the 400%-zoom equivalent, and
 * a spoken save-failure announcement that keeps the selection intact.
 */

const QUEST_STATUSES = ['available', 'active', 'completed', 'failed'] as const;
const LOCATION_STATUSES = ['unexplored', 'explored', 'current'] as const;

// ---------------------------------------------------------------------------
// Quest status picker
// ---------------------------------------------------------------------------

test.describe('quest status picker accessibility', () => {
  test.use({ storageState: stateFor('dm') });

  // The suite shares one seeded backend (workers: 1). Several of these tests
  // mutate the quest's status, so reset it to the seeded 'active' value before
  // every test via a direct API call — keeping each test order-independent.
  test.beforeEach(async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.request.post(`/api/v1/quests/${fixture.quests.active.id}/status`, { data: { status: 'active' } });
  });

  test('exposes listbox semantics, selected state, and the full keyboard contract', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/quests/${fixture.quests.active.id}`);

    const trigger = page.getByRole('button', { name: /^Quest status:/ });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');

    // The listbox is not yet in the tree until the trigger expands it.
    await expect(page.getByRole('listbox')).toHaveCount(0);

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-controls', await listbox.getAttribute('id') ?? '');

    // The committed status (active) is exposed as the selected option, and the
    // keyboard focus begins on it.
    const selected = listbox.getByRole('option', { selected: true, name: 'Active' });
    await expect(selected).toBeFocused();
    for (const status of QUEST_STATUSES) {
      const word = wordFor(status);
      const option = listbox.getByRole('option', { name: new RegExp(`^${word}`) });
      await expect(option).toBeVisible();
      await expect(option).toHaveAttribute('aria-selected', status === 'active' ? 'true' : 'false');
    }

    // ArrowDown moves visual focus to the next option without committing it.
    await page.keyboard.press('ArrowDown');
    await expect(listbox.getByRole('option', { name: 'Completed' })).toBeFocused();
    // Selection is still on Active until the user commits.
    await expect(selected).toHaveAttribute('aria-selected', 'true');

    // Home jumps to the first option, End to the last.
    await page.keyboard.press('Home');
    await expect(listbox.getByRole('option', { name: 'Available' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(listbox.getByRole('option', { name: 'Failed' })).toBeFocused();

    // Escape closes and restores focus to the trigger without committing.
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The quest status badge in the header is still Active.
    await expect(page.getByRole('heading', { name: fixture.quests.active.title })).toBeVisible();
  });

  test('commits via Enter and Space, then announces the new status', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Keyboard timing is stable on Chromium');
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/quests/${fixture.quests.active.id}`);

    const trigger = page.getByRole('button', { name: /^Quest status:/ });

    // --- Enter commit -------------------------------------------------------
    // Open with the keyboard, walk to Completed with ArrowDown, commit with Enter.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'Active' })).toBeFocused();
    await page.keyboard.press('ArrowDown'); // Active -> Completed
    await expect(listbox.getByRole('option', { name: 'Completed' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // The header badge + facts badge now reflect Completed, and the polite
    // announcer spoke the change.
    await expect(
      page.locator('[data-semantic="quest-status"][data-semantic-value="completed"]'),
    ).toHaveCount(2);
    await expect(page.locator('[aria-live="polite"]')).toContainText(/Quest status set to Completed\./);

    // --- Space commit -------------------------------------------------------
    // Reopen, walk back up to Active, commit with Space.
    await trigger.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'Completed' })).toBeFocused();
    await page.keyboard.press('ArrowUp'); // Completed -> Active
    await expect(listbox.getByRole('option', { name: 'Active', exact: true })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.locator('[data-semantic="quest-status"][data-semantic-value="active"]'),
    ).toHaveCount(2);
  });

  test('preserves selection and announces a save failure', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/quests/${fixture.quests.active.id}`);

    // Force the status POST to fail once so the failure path runs.
    await page.route(`**/api/v1/quests/${fixture.quests.active.id}/status`, async (route) => {
      await route.fulfill({ status: 503, json: { message: 'Temporary status failure' } });
    });

    const trigger = page.getByRole('button', { name: /^Quest status:/ });
    await trigger.click();
    const listbox = page.getByRole('listbox');
    await listbox.getByRole('option', { name: 'Completed' }).click();

    // The page surfaces the failure, and the committed status stays Active —
    // the popup never silently adopted the failed choice.
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't update quest status" })).toBeVisible();
    await expect(page.locator('[data-semantic="quest-status"][data-semantic-value="active"]')).toHaveCount(2);

    // Reopening the menu still marks Active as the selected option.
    await trigger.click();
    await expect(page.getByRole('listbox').getByRole('option', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    // Unroute so the page state is clean for any following test in the worker.
    await page.unroute(`**/api/v1/quests/${fixture.quests.active.id}/status`);
  });

  test('dismisses on outside click and stays in viewport at 400% zoom', async ({ browser }) => {
    const { semantic: fixture } = seed();
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 320, height: 720 },
    });
    const page = await context.newPage();
    try {
      await page.goto(`/c/${fixture.campaignId}/quests/${fixture.quests.active.id}`);

      const trigger = page.getByRole('button', { name: /^Quest status:/ });
      await trigger.click();
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible();

      // Clicking the page heading (outside the popup) dismisses without committing.
      await page.getByRole('heading', { name: fixture.quests.active.title }).click();
      await expect(listbox).toHaveCount(0);
      await expect(page.locator('[data-semantic="quest-status"][data-semantic-value="active"]')).toHaveCount(2);

      // Reopen and assert the popup is fully on screen at the narrow viewport.
      await trigger.click();
      await expect(page.getByRole('listbox')).toBeVisible();
      const box = await page.getByRole('listbox').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);

      const accessibilityScan = await new AxeBuilder({ page }).include('[role="listbox"]').analyze();
      expect(accessibilityScan.violations).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Location status picker
// ---------------------------------------------------------------------------

test.describe('location status picker accessibility', () => {
  test.use({ storageState: stateFor('dm') });

  // Reset the shared seeded location to 'explored' before every test so each
  // spec is order-independent regardless of what the prior test committed.
  test.beforeEach(async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.request.post(`/api/v1/locations/${fixture.locationId}/discover`, { data: { status: 'explored' } });
  });

  test('exposes listbox semantics, selected state, and the full keyboard contract', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/locations/${fixture.locationId}`);

    const trigger = page.getByRole('button', { name: /^Location status:/ });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-controls', await listbox.getAttribute('id') ?? '');

    // The seeded location is explored.
    const selected = listbox.getByRole('option', { selected: true, name: 'Explored' });
    await expect(selected).toBeFocused();
    for (const status of LOCATION_STATUSES) {
      const word = wordFor(status);
      const option = listbox.getByRole('option', { name: new RegExp(`^${word}`) });
      await expect(option).toBeVisible();
      await expect(option).toHaveAttribute('aria-selected', status === 'explored' ? 'true' : 'false');
    }

    await page.keyboard.press('ArrowDown');
    await expect(listbox.getByRole('option', { name: 'Current' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(listbox.getByRole('option', { name: 'Unexplored' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(listbox.getByRole('option', { name: 'Current' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('commits via Enter and updates the header chip', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/locations/${fixture.locationId}`);

    const trigger = page.getByRole('button', { name: /^Location status:/ });
    await trigger.click();
    const listbox = page.getByRole('listbox');

    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/locations/${fixture.locationId}/discover`) &&
      response.request().method() === 'POST',
    );
    await listbox.getByRole('option', { name: 'Current' }).press('Enter');
    await responsePromise;

    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The header chip now reads Current.
    await expect(page.locator('h1 + *').filter({ hasText: 'Current' })).toBeVisible();
    await expect(page.locator('[aria-live="polite"]')).toContainText(/Location status set to Current\./);
  });

  test('preserves selection and announces a save failure', async ({ page }) => {
    const { semantic: fixture } = seed();
    await page.goto(`/c/${fixture.campaignId}/locations/${fixture.locationId}`);

    await page.route(`**/api/v1/locations/${fixture.locationId}/discover`, async (route) => {
      await route.fulfill({ status: 503, json: { message: 'Temporary status failure' } });
    });

    const trigger = page.getByRole('button', { name: /^Location status:/ });
    await trigger.click();
    await page.getByRole('listbox').getByRole('option', { name: 'Current' }).click();

    // The page surfaces the failure as an alert (generic, stable message) and
    // the polite announcer re-speaks it so screen reader users learn the save
    // did not stick.
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't update status" })).toBeVisible();
    await expect(page.locator('[aria-live="polite"]')).toContainText(/Couldn't update status\./);
    // The location status stays Explored — no silent adoption of the failed pick.
    await expect(page.locator('h1 + *').filter({ hasText: 'Explored' })).toBeVisible();

    await trigger.click();
    await expect(page.getByRole('listbox').getByRole('option', { name: 'Explored', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    await page.unroute(`**/api/v1/locations/${fixture.locationId}/discover`);
  });

  test('Tab commits the focused option and stays axe-clean at 400% zoom', async ({ browser }) => {
    const { semantic: fixture } = seed();
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 320, height: 720 },
    });
    const page = await context.newPage();
    try {
      await page.goto(`/c/${fixture.campaignId}/locations/${fixture.locationId}`);

      const trigger = page.getByRole('button', { name: /^Location status:/ });
      await trigger.click();
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible();

      const box = await listbox.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);

      // Tab commits the focused option (Current) and leaves the menu.
      await listbox.getByRole('option', { name: 'Current' }).focus();
      await page.keyboard.press('Tab');
      await expect(listbox).toHaveCount(0);
      await expect(page.locator('h1 + *').filter({ hasText: 'Current' })).toBeVisible();

      // The status picker itself must stay axe-clean at 400% zoom. Scope the
      // scan to the menu region so a pre-existing RevisionHistoryPanel
      // color-contrast issue elsewhere on the page doesn't mask this work.
      await trigger.click();
      const accessibilityScan = await new AxeBuilder({ page }).include('[role="listbox"]').analyze();
      expect(accessibilityScan.violations).toEqual([]);
      await page.keyboard.press('Escape');
    } finally {
      await context.close();
    }
  });
});

/** Map an enum value to its visible label word for option matching. */
function wordFor(status: string): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'active':
      return 'Active';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'unexplored':
      return 'Unexplored';
    case 'explored':
      return 'Explored';
    case 'current':
      return 'Current';
    default:
      return status;
  }
}

// Page is imported for the standalone reflow helper below; keep the import so
// the type stays available to editors without a noUnusedLocators complaint.
export type _PageRef = Page;
