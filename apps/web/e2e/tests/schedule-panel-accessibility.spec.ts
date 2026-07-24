import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { ScheduledSessionWithRsvps } from '@campfire/schema';
import {
  datetimeLocalDaysFromNow,
  RSVP_GROUP_LEGEND,
  SCHEDULE_WHEN_HELP,
  rsvpOptionDescription,
} from '../../src/features/sessions/schedulePanelA11y';
import { seed, stateFor } from './seed';

async function json<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function clearIssue645Schedules(request: APIRequestContext, campaignId: number): Promise<void> {
  const schedules = await json<ScheduledSessionWithRsvps[]>(
    await request.get(`/api/v1/campaigns/${campaignId}/schedule`),
    'list issue #645 schedules',
  );
  for (const schedule of schedules.filter((item) => item.title.startsWith('E2E645 '))) {
    await json<unknown>(await request.delete(`/api/v1/schedule/${schedule.id}`), 'remove prior issue #645 schedule');
  }
}

/** App-root Announcer polite region (bare div — feature status regions use role=status). */
function appPoliteAnnouncer(page: Page) {
  return page.locator('div.sr-only[aria-live="polite"][aria-atomic="true"]:not([role])');
}

function appAssertiveAnnouncer(page: Page) {
  return page.locator('.sr-only[role="alert"][aria-live="assertive"]');
}

function scheduleCard(page: Page, scheduleId: number) {
  return page.locator(`[data-entity-id="${scheduleId}"]`);
}

/**
 * Issue #645 — Schedule tab labeled fields, RSVP radiogroup, save announcements,
 * and rollback when the RSVP PUT fails.
 */
test.describe('Schedule panel accessibility (issue #645)', () => {
  test.use({ storageState: stateFor('player') });

  test('player RSVP radiogroup saves, announces, and is keyboard-operable', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Keyboard timing is stable on Chromium');
    const { campaignId, navigation } = seed();
    const scheduleId = navigation.scheduledSessionId;
    await page.goto(`/c/${campaignId}/sessions?tab=schedule`);

    const card = scheduleCard(page, scheduleId);
    const chooser = card.getByTestId('schedule-rsvp-chooser');
    await expect(chooser).toBeVisible();
    await expect(chooser).toHaveAttribute('role', 'radiogroup');
    await expect(card.getByText(RSVP_GROUP_LEGEND, { exact: true })).toBeVisible();

    await chooser.getByRole('radio', { name: new RegExp(`^${rsvpOptionDescription('yes')}`, 'i') }).click();
    await expect(chooser.getByRole('radio', { name: /^in —/i })).toHaveAttribute('aria-checked', 'true');
    await expect(appPoliteAnnouncer(page)).toContainText(/RSVP saved: you are in/i);

    await chooser.getByRole('radio', { name: /^maybe —/i }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(chooser.getByRole('radio', { name: /^out —/i })).toHaveAttribute('aria-checked', 'true');
    await expect(appPoliteAnnouncer(page)).toContainText(/RSVP saved: you are out/i);

    const scan = await new AxeBuilder({ page }).include('.cf-schedule-rsvp').disableRules(['color-contrast']).analyze();
    expect(scan.violations).toEqual([]);
  });

  test('preserves RSVP and announces when the save fails', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const scheduledSessionId = navigation.scheduledSessionId;
    await page.request.put(`/api/v1/schedule/${scheduledSessionId}/rsvp`, { data: { status: 'yes' } });
    await page.goto(`/c/${campaignId}/sessions?tab=schedule`);

    await page.route(`**/api/v1/schedule/${scheduledSessionId}/rsvp`, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 503, json: { message: 'Temporary RSVP failure' } });
        return;
      }
      await route.continue();
    });

    const card = scheduleCard(page, scheduledSessionId);
    const chooser = card.getByTestId('schedule-rsvp-chooser');
    await chooser.getByRole('radio', { name: /^maybe —/i }).click();

    await expect(card.getByRole('alert').filter({ hasText: "Couldn't save your RSVP" })).toBeVisible();
    await expect(appAssertiveAnnouncer(page)).toContainText(/Couldn't save your RSVP/i);
    await expect(chooser.getByRole('radio', { name: /^in —/i })).toHaveAttribute('aria-checked', 'true');

    await page.unroute(`**/api/v1/schedule/${scheduledSessionId}/rsvp`);
  });

  test('touch viewport can pick an RSVP without hover', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const scheduleId = navigation.scheduledSessionId;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/c/${campaignId}/sessions?tab=schedule`);

    const chooser = scheduleCard(page, scheduleId).getByTestId('schedule-rsvp-chooser');
    // Narrow viewport — no hover path; a plain click is the touch-equivalent path.
    await chooser.getByRole('radio', { name: /^maybe —/i }).click();
    await expect(chooser.getByRole('radio', { name: /^maybe —/i })).toHaveAttribute('aria-checked', 'true');
    await expect(appPoliteAnnouncer(page)).toContainText(/RSVP saved: maybe/i);
  });
});

test.describe('Schedule panel form accessibility (issue #645)', () => {
  test.use({ storageState: stateFor('dm') });

  test('schedule form exposes labeled fields with durable help', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/sessions?tab=schedule`);

    await page.getByRole('button', { name: '+ Schedule session' }).click();
    const when = page.getByLabel('When');
    await expect(when).toBeVisible();
    await expect(when).toHaveAccessibleDescription(SCHEDULE_WHEN_HELP);
    await expect(page.getByLabel('Duration (minutes)')).toHaveAccessibleDescription(/15-minute/i);
    await expect(page.getByLabel('Title')).toHaveAccessibleDescription(/optional label/i);

    const formScan = await new AxeBuilder({ page })
      .include('[aria-label="Schedule the next session"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(formScan.violations).toEqual([]);
  });

  test('DM can schedule with spoken confirmation at 400% zoom equivalent', async ({ browser }) => {
    const { campaignId } = seed();
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 320, height: 720 },
    });
    const page = await context.newPage();
    try {
      await clearIssue645Schedules(page.request, campaignId);
      await page.goto(`/c/${campaignId}/sessions?tab=schedule`);
      await page.getByRole('button', { name: '+ Schedule session' }).click();

      const when = page.getByLabel('When');
      await when.fill(datetimeLocalDaysFromNow(30, 18, 0));
      await page.getByLabel('Duration (minutes)').fill('180');
      await page.getByLabel('Title').fill('E2E645 Zoom night');

      const box = await when.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);

      const createResponse = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/v1/campaigns/${campaignId}/schedule`) &&
          res.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Schedule', exact: true }).click();
      await createResponse;

      await expect(appPoliteAnnouncer(page)).toContainText(/Session scheduled: E2E645 Zoom night/i);
      await expect(
        page.locator('[data-entity-type="scheduled_session"]').filter({ hasText: 'E2E645 Zoom night' }),
      ).toBeVisible();
    } finally {
      await clearIssue645Schedules(page.request, campaignId).catch(() => undefined);
      await context.close();
    }
  });
});
