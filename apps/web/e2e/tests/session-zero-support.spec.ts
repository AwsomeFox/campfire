import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * The Access-support section's own live region.
 *
 * Scoped deliberately. A bare `page.getByRole('status')` is page-wide, and this page has
 * other `role="status"` elements — the charter save-status label, and `<Skeleton>`, which
 * renders `role="status" aria-busy="true"` of its own (SkeletonStatus, components/ui.tsx).
 * Two matches would be a Playwright strict-mode violation, which fails outright instead of
 * retrying (see campaign-audit.spec.ts, where exactly that happened).
 *
 * This is NOT currently redundant-but-harmless — it is load-bearing against two accidents:
 *
 *  1. The skeleton is gated on `loading && !charter`, while the whole Access-support
 *     section is gated on `!loading`. They cannot coexist TODAY, but that mutual exclusion
 *     is an incidental consequence of two separate conditionals, not a guarantee anyone
 *     wrote down or tests.
 *  2. The charter save-status label renders only when `protectedCharter.saveStatusLabel` is
 *     set, which needs a CHARTER save; these tests only save the support preference.
 *
 * Either could change without anyone touching this file, at which point an unscoped query
 * starts matching two elements and this spec fails on a mechanism that has nothing to do
 * with what it tests. Please do not "simplify" this back to a page-wide query.
 */
const supportStatus = (page: Page) =>
  page.locator('[aria-labelledby="access-support-heading"]').getByRole('status');

test.describe.serial('Session Zero participant-owned access support', () => {
  test('desktop keyboard flow keeps facilitator visibility separate from AI consent', async ({ browser }) => {
    const { campaignId } = seed();
    const playerContext = await browser.newContext({ storageState: stateFor('player') });
    const player = await playerContext.newPage();
    await player.goto(`/c/${campaignId}/session-zero`);

    const support = player.getByRole('textbox', { name: 'What would help you participate comfortably?' });
    await support.fill('DESKTOP_SUPPORT_877: pause briefly before asking for my action.');
    await expect(player.getByRole('radio', { name: /Facilitators only/ })).toBeChecked();
    const aiConsent = player.getByRole('checkbox', { name: /Allow Campfire AI features/ });
    await aiConsent.focus();
    await player.keyboard.press('Space');
    await expect(aiConsent).toBeChecked();

    const save = player.getByRole('button', { name: 'Save preference' });
    await save.focus();
    await player.keyboard.press('Enter');
    await expect(supportStatus(player)).toContainText('saved');
    const playerAxe = await new AxeBuilder({ page: player }).include('[aria-labelledby="access-support-heading"]').analyze();
    expect(playerAxe.violations).toEqual([]);

    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const dm = await dmContext.newPage();
    await dm.goto(`/c/${campaignId}/session-zero`);
    await expect(dm.getByText('Facilitator prep / live summary')).toBeVisible();
    await expect(dm.getByText(/DESKTOP_SUPPORT_877/)).toBeVisible();

    const viewerContext = await browser.newContext({ storageState: stateFor('viewer') });
    const viewer = await viewerContext.newPage();
    await viewer.goto(`/c/${campaignId}/session-zero`);
    await expect(viewer.getByText(/DESKTOP_SUPPORT_877/)).toHaveCount(0);

    await player.getByRole('button', { name: 'Delete my submission' }).focus();
    await player.keyboard.press('Enter');
    await player.getByRole('button', { name: 'Confirm delete' }).focus();
    await player.keyboard.press('Enter');
    await expect(supportStatus(player)).toContainText('deleted');

    await playerContext.close();
    await dmContext.close();
    await viewerContext.close();
  });

  test('mobile table-sharing flow is responsive, keyboard-operable, and axe-clean', async ({ browser }) => {
    const { campaignId } = seed();
    const context = await browser.newContext({
      storageState: stateFor('player'),
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    await page.goto(`/c/${campaignId}/session-zero`);

    await page.getByRole('textbox', { name: 'What would help you participate comfortably?' })
      .fill('MOBILE_TABLE_SUPPORT_877: use explicit turn cues.');
    const tableRadio = page.getByRole('radio', { name: /Entire table/ });
    await tableRadio.focus();
    await page.keyboard.press('Space');
    await expect(tableRadio).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Allow Campfire AI features/ })).not.toBeChecked();
    await page.getByRole('button', { name: 'Save preference' }).click();
    await expect(supportStatus(page)).toContainText('saved');

    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    const axe = await new AxeBuilder({ page }).include('[aria-labelledby="access-support-heading"]').analyze();
    expect(axe.violations).toEqual([]);

    const viewerContext = await browser.newContext({
      storageState: stateFor('viewer'),
      viewport: { width: 375, height: 812 },
    });
    const viewer = await viewerContext.newPage();
    await viewer.goto(`/c/${campaignId}/session-zero`);
    await expect(viewer.getByText(/MOBILE_TABLE_SUPPORT_877/)).toBeVisible();
    const viewerAxe = await new AxeBuilder({ page: viewer }).include('[aria-labelledby="access-support-heading"]').analyze();
    expect(viewerAxe.violations).toEqual([]);

    await page.getByRole('button', { name: 'Delete my submission' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await viewer.reload();
    await expect(viewer.getByText(/MOBILE_TABLE_SUPPORT_877/)).toHaveCount(0);

    await viewerContext.close();
    await context.close();
  });
});
