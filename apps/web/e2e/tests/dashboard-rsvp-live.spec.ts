import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { ScheduledSessionWithRsvps } from '@campfire/schema';
import { seed, stateFor } from './seed';

async function json<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function clearIssueSchedules(request: APIRequestContext, campaignId: number): Promise<void> {
  const schedules = await json<ScheduledSessionWithRsvps[]>(
    await request.get(`/api/v1/campaigns/${campaignId}/schedule`),
    'list issue #785 schedules',
  );
  for (const schedule of schedules.filter((item) => item.title.startsWith('E2E785 '))) {
    await json<unknown>(await request.delete(`/api/v1/schedule/${schedule.id}`), 'remove prior issue #785 schedule');
  }
}

/**
 * Issue #785 — dashboard shows the viewer's saved RSVP and live-updates when
 * attendance changes (own response or remote write), instead of always
 * prompting "RSVP →".
 */
test('dashboard RSVP cue reflects the viewer response and remote changes', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  try {
    await clearIssueSchedules(writer.request, campaignId);

    const created = await json<ScheduledSessionWithRsvps>(
      await writer.request.post(`/api/v1/campaigns/${campaignId}/schedule`, {
        // Before the global-setup seed 'DLRNAV Saturday Game' (2032-07-24) so
        // this remains the soonest next-session projection.
        data: { scheduledAt: '2027-10-05T18:00:00Z', title: 'E2E785 Table night' },
      }),
      'create issue #785 schedule',
    );

    const initialStream = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/events`),
    );
    await page.goto(`/c/${campaignId}`);
    await initialStream;

    const nextSessionLink = page.locator('.dashboard-session-log a').filter({ hasText: 'E2E785 Table night' });
    await expect(nextSessionLink).toBeVisible();
    const cue = nextSessionLink.locator('[data-testid="dashboard-rsvp-cue"]');

    // Unanswered: prioritize the RSVP-needed affordance only.
    await expect(cue).toHaveAttribute('data-rsvp-unanswered', 'true');
    await expect(cue).toContainText('RSVP needed');
    await expect(cue).not.toContainText('Change RSVP');

    // Player answers from another surface (schedule API). Dashboard must
    // live-update via schedule.updated → summary refetch — no reload.
    await json<ScheduledSessionWithRsvps>(
      await reader.request.put(`/api/v1/schedule/${created.id}/rsvp`, { data: { status: 'yes' } }),
      'player RSVP yes',
    );
    await expect(cue).toHaveAttribute('data-rsvp-unanswered', 'false');
    await expect(cue).toContainText("You're in");
    await expect(cue).toContainText('Change RSVP');
    await expect(cue).not.toContainText('RSVP needed');

    // Remote change (same viewer revising from another client) updates the cue.
    await json<ScheduledSessionWithRsvps>(
      await reader.request.put(`/api/v1/schedule/${created.id}/rsvp`, { data: { status: 'maybe' } }),
      'player RSVP maybe remotely',
    );
    await expect(cue).toContainText('Maybe');
    await expect(cue).toContainText('Change RSVP');

    await json<ScheduledSessionWithRsvps>(
      await reader.request.put(`/api/v1/schedule/${created.id}/rsvp`, { data: { status: 'no' } }),
      'player RSVP no remotely',
    );
    await expect(cue).toContainText("You're out");
    await expect(cue).toContainText('Change RSVP');

    // The whole next-session card remains a keyboard-operable schedule link.
    await nextSessionLink.focus();
    await expect(nextSessionLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/c/${campaignId}/sessions?tab=schedule`);
  } finally {
    await clearIssueSchedules(writer.request, campaignId).catch(() => undefined);
    await Promise.all([reader.close(), writer.close()]);
  }
});
