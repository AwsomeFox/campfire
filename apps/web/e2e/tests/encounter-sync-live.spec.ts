import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #471 — encounter run-session sync indicator and guarded actions across
 * multi-client disconnect/reconnect.
 */
test('encounter run session pauses risky actions while SSE is down and resyncs on reconnect', async ({ browser }) => {
  const { campaignId } = seed();
  const writer = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  let encounterId: number | null = null;
  let blockEvents = false;
  let eventAttempts = 0;

  try {
    await writer.request.post('/api/v1/auth/login', { data: { username: 'dm', password: 'dm' } }).catch(() => undefined);

    const live = await (await writer.request.get(`/api/v1/campaigns/${campaignId}/encounters?status=running`)).json();
    for (const e of live as { id: number }[]) {
      await writer.request.post(`/api/v1/encounters/${e.id}/end`);
    }

    const enc = await (
      await writer.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
        data: { name: 'E2E471 Sync', hidden: false },
      })
    ).json();
    encounterId = enc.id;
    await writer.request.post(`/api/v1/encounters/${encounterId}/roll-initiative`);
    await writer.request.post(`/api/v1/encounters/${encounterId}/start`);

    await reader.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      eventAttempts += 1;
      if (blockEvents) await route.abort('connectionfailed');
      else await route.continue();
    });

    const initialStream = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/events`),
    );
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await initialStream;

    const syncChip = page.getByTestId('encounter-sync-chip');
    await expect(syncChip).toBeVisible();
    await expect(syncChip).toHaveText('Live');

    const nextTurn = page.getByTestId('encounter-header-next-turn');
    await expect(nextTurn).toBeEnabled();

    await reader.setOffline(true);
    await expect(page.getByTestId('encounter-sync-chip')).toHaveText('Offline');
    await expect(page.getByTestId('encounter-sync-banner')).toContainText(/Combat actions are paused/i);
    await expect(nextTurn).toBeDisabled();

    await writer.request.post(`/api/v1/encounters/${encounterId}/next-turn`);

    blockEvents = true;
    const attemptsBeforeRestore = eventAttempts;
    await reader.setOffline(false);
    await expect.poll(() => eventAttempts).toBeGreaterThan(attemptsBeforeRestore);
    await expect(page.getByTestId('encounter-sync-chip')).toHaveText(/Reconnecting|Stale/);
    await expect(nextTurn).toBeDisabled();

    blockEvents = false;
    await expect(page.getByTestId('encounter-sync-chip')).toHaveText('Live', { timeout: 15_000 });
    await expect(page.getByTestId('encounter-sync-banner')).toHaveCount(0);
    await expect(nextTurn).toBeEnabled();
  } finally {
    if (encounterId != null) {
      await writer.request.post(`/api/v1/encounters/${encounterId}/end`).catch(() => undefined);
      await writer.request.delete(`/api/v1/encounters/${encounterId}`).catch(() => undefined);
    }
    await Promise.all([reader.close(), writer.close()]);
  }
});
