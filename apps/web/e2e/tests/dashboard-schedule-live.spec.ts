import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Campaign, CampaignMember, ScheduledSessionWithRsvps } from '@campfire/schema';
import { seed, stateFor } from './seed';

async function json<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function clearIssueSchedules(request: APIRequestContext, campaignId: number): Promise<void> {
  const schedules = await json<ScheduledSessionWithRsvps[]>(
    await request.get(`/api/v1/campaigns/${campaignId}/schedule`),
    'list issue #790 schedules',
  );
  for (const schedule of schedules.filter((item) => item.title.startsWith('E2E790 '))) {
    await json<unknown>(await request.delete(`/api/v1/schedule/${schedule.id}`), 'remove prior issue #790 schedule');
  }
}

test('dashboard next-session projection stays live across remote writes, campaign switches, and reconnects', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  try {
    await clearIssueSchedules(writer.request, campaignId);

    // Build a second campaign before the reader loads /me so its role snapshot and
    // campaign list both include the new membership. This makes the route-param
    // switch exercise the same mounted DashboardPage rather than a full reload.
    const members = await json<CampaignMember[]>(
      await writer.request.get(`/api/v1/campaigns/${campaignId}/members`),
      'list campaign members',
    );
    const playerMember = members.find((member) => member.username === 'player');
    expect(playerMember).toBeDefined();

    const secondCampaign = await json<Campaign>(
      await writer.request.post('/api/v1/campaigns', { data: { name: `E2E790 Switch ${Date.now()}` } }),
      'create switch campaign',
    );
    await json<CampaignMember>(
      await writer.request.post(`/api/v1/campaigns/${secondCampaign.id}/members`, {
        data: { userId: playerMember!.userId, role: 'player' },
      }),
      'add reader to switch campaign',
    );
    await json<ScheduledSessionWithRsvps>(
      await writer.request.post(`/api/v1/campaigns/${secondCampaign.id}/schedule`, {
        // Dates stay before the global-setup seed 'DLRNAV Saturday Game'
        // (2032-07-24) so the test-authored sessions remain the campaign's
        // soonest "next session" projection, and after today so they are future.
        data: { scheduledAt: '2027-09-20T18:00:00Z', title: 'E2E790 Other campaign' },
      }),
      'schedule second campaign',
    );

    let blockEvents = false;
    let eventAttempts = 0;
    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      eventAttempts += 1;
      if (blockEvents) await route.abort('connectionfailed');
      else await route.continue();
    });

    const initialStream = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/events`),
    );
    await page.goto(`/c/${campaignId}`);
    await initialStream;
    await expect(page.locator('.dashboard-session-log')).toBeVisible();

    const created = await json<ScheduledSessionWithRsvps>(
      await writer.request.post(`/api/v1/campaigns/${campaignId}/schedule`, {
        data: { scheduledAt: '2027-08-10T18:00:00Z', title: 'E2E790 Alpha' },
      }),
      'create remote schedule',
    );
    await expect(page.getByText('E2E790 Alpha', { exact: true })).toBeVisible();

    await json<ScheduledSessionWithRsvps>(
      await writer.request.patch(`/api/v1/schedule/${created.id}`, {
        data: { scheduledAt: '2027-08-17T19:30:00Z', title: 'E2E790 Beta', location: 'Replacement table' },
      }),
      'reschedule remotely',
    );
    await expect(page.getByText('E2E790 Beta', { exact: true })).toBeVisible();
    await expect(page.getByText('E2E790 Alpha', { exact: true })).toHaveCount(0);

    // The card is a real touch-sized link and remains keyboard-operable/axe-clean
    // at the narrow mobile breakpoint.
    await page.setViewportSize({ width: 375, height: 812 });
    const nextSessionLink = page.locator('.dashboard-session-log a').filter({ hasText: 'E2E790 Beta' });
    await expect(nextSessionLink).toBeVisible();
    expect((await nextSessionLink.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const accessibility = await new AxeBuilder({ page }).include('.dashboard-session-log').analyze();
    expect(accessibility.violations).toEqual([]);
    await nextSessionLink.focus();
    await expect(nextSessionLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/c/${campaignId}/sessions?tab=schedule`);
    await page.goBack();
    await expect(page.getByText('E2E790 Beta', { exact: true })).toBeVisible();

    // Delay the other campaign's projection so the assertion can observe the
    // transition boundary: no title from campaign A may flash under campaign B.
    let releaseSecondSummary: () => void = () => {};
    const secondSummaryGate = new Promise<void>((resolve) => { releaseSecondSummary = resolve; });
    await page.route(`**/api/v1/campaigns/${secondCampaign.id}/summary`, async (route) => {
      await secondSummaryGate;
      await route.continue();
    });
    await page.evaluate((url) => {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/c/${secondCampaign.id}`);
    await expect(page).toHaveURL(`/c/${secondCampaign.id}`);
    await expect(page.getByText('E2E790 Beta', { exact: true })).toHaveCount(0);
    releaseSecondSummary();
    await expect(page.getByText('E2E790 Other campaign', { exact: true })).toBeVisible();
    await page.unroute(`**/api/v1/campaigns/${secondCampaign.id}/summary`);

    await page.evaluate((url) => {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/c/${campaignId}`);
    await expect(page.getByText('E2E790 Beta', { exact: true })).toBeVisible();

    // Drop only the reader. The writer can move the session while the dashboard
    // explicitly labels its old projection offline. Keep SSE blocked briefly on
    // restore to exercise the distinct online-but-stale state, then let the normal
    // reconnect callback catch up without a schedule-specific poll.
    await reader.setOffline(true);
    await expect(page.getByText('Offline — showing last-known next-session details.')).toBeVisible();
    await json<ScheduledSessionWithRsvps>(
      await writer.request.patch(`/api/v1/schedule/${created.id}`, {
        data: { scheduledAt: '2027-08-24T20:00:00Z', title: 'E2E790 Gamma', location: 'Remote table' },
      }),
      'reschedule while reader is offline',
    );
    await expect(page.getByText('E2E790 Beta', { exact: true })).toBeVisible();
    await expect(page.getByText('E2E790 Gamma', { exact: true })).toHaveCount(0);

    blockEvents = true;
    const attemptsBeforeRestore = eventAttempts;
    await reader.setOffline(false);
    await expect.poll(() => eventAttempts).toBeGreaterThan(attemptsBeforeRestore);
    await expect(page.getByText('Live updates interrupted — showing last-known next-session details.')).toBeVisible();

    blockEvents = false;
    await expect(page.getByText('E2E790 Gamma', { exact: true })).toBeVisible();
    await expect(page.getByText(/showing last-known next-session details/)).toHaveCount(0);

    await json<unknown>(await writer.request.delete(`/api/v1/schedule/${created.id}`), 'cancel remotely');
    await expect(page.getByText('E2E790 Gamma', { exact: true })).toHaveCount(0);
    // The global-setup seed 'DLRNAV Saturday Game' (2032-07-24) is the
    // campaign's only remaining future session, so once the test-authored
    // Gamma session is cancelled the live projection falls back to it —
    // proving the deletion propagated rather than the card staying stale.
    await expect(page.locator('.dashboard-session-log a').filter({ hasText: 'DLRNAV Saturday Game' })).toBeVisible();
  } finally {
    await Promise.all([reader.close(), writer.close()]);
  }
});
