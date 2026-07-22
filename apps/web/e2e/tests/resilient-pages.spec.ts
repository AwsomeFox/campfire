import { test, expect } from '@playwright/test';
import { NPC_NAME } from '../global-setup';
import { seed, stateFor } from './seed';

/**
 * Resilient pages (issue #697): an auxiliary API failure must never blank the
 * primary content, never map to a page-level 404/error, and must offer a retry
 * that re-fetches ONLY the failed panel (succeeding when the outage clears).
 *
 * Each test follows the same shape:
 *   1. intercept the auxiliary endpoint -> 503
 *   2. assert the page's core content renders
 *   3. assert the failed panel shows an inline, role="alert" error + Retry
 *   4. clear the interception so the endpoint succeeds, click Retry, assert the
 *      panel's real content appears (primary content stayed the whole time)
 *
 * Route interception mirrors the established pattern in notifications.spec.ts.
 */

// DM-only auxiliary endpoints are exercised under the DM storage state so the
// panels are actually mounted.
test.use({ storageState: stateFor('dm') });

test.describe('issue #697 — auxiliary failure isolation', () => {
  test('SchedulePanel keeps the schedule when the calendar feed fails', async ({ page }) => {
    const { campaignId } = seed();
    const FEED_URL = `**/api/v1/campaigns/${campaignId}/calendar-feed`;

    await page.route(FEED_URL, (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));

    await page.goto(`/c/${campaignId}/sessions?tab=schedule`);

    // Core content: the schedule heading renders (the page did not 404 or blank).
    await expect(page.getByRole('heading', { name: 'Next session' })).toBeVisible();

    // Auxiliary failure: the feed card shows an inline alert with a Retry, not a
    // page-level error. The schedule panel's own error (if any) must not appear.
    const feedAlert = page
      .getByRole('alert')
      .filter({ hasText: "Couldn't load the calendar feed." });
    await expect(feedAlert).toBeVisible();
    await expect(feedAlert.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load the schedule." })).toHaveCount(0);

    // Retry only the feed: clear the outage, click Retry, and the feed UI recovers.
    await page.unroute(FEED_URL);
    await page.route(FEED_URL, (route) => route.continue());
    await feedAlert.getByRole('button', { name: 'Retry' }).click();
    // Once recovered, the feed error is gone and the "Calendar feed" card body renders.
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load the calendar feed." })).toHaveCount(0);
    await expect(page.getByText('Enable the feed to get a private URL')).toBeVisible();
  });

  test('MembersPage keeps the roster when characters fail', async ({ page }) => {
    const { campaignId } = seed();
    const CHARACTERS_URL = `**/api/v1/campaigns/${campaignId}/characters`;

    await page.route(CHARACTERS_URL, (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));

    await page.goto(`/c/${campaignId}/members`);

    // Core content: the page heading + members card render.
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();

    // Auxiliary failure: the characters panel shows an inline alert with Retry.
    const charAlert = page.getByRole('alert').filter({ hasText: "Couldn't load characters for linking." });
    await expect(charAlert).toBeVisible();
    await expect(charAlert.getByRole('button', { name: 'Retry' })).toBeVisible();
    // No page-level "Couldn't load members." error.
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load members." })).toHaveCount(0);

    // Retry only characters: clear the outage, click Retry, the alert clears.
    await page.unroute(CHARACTERS_URL);
    await page.route(CHARACTERS_URL, (route) => route.continue());
    await charAlert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load characters for linking." })).toHaveCount(0);
  });

  test('MembersPage keeps the roster when the audit log fails', async ({ page }) => {
    const { campaignId } = seed();
    const AUDIT_URL = `**/api/v1/campaigns/${campaignId}/audit`;

    await page.route(AUDIT_URL, (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));

    await page.goto(`/c/${campaignId}/members`);

    // Core content renders; the audit card heading is visible.
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

    // Auxiliary failure is inline under the audit card, with a Retry.
    const auditAlert = page.getByRole('alert').filter({ hasText: "Couldn't load the audit log." });
    await expect(auditAlert).toBeVisible();
    await expect(auditAlert.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load members." })).toHaveCount(0);

    // Retry only the audit log.
    await page.unroute(AUDIT_URL);
    await page.route(AUDIT_URL, (route) => route.continue());
    await auditAlert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load the audit log." })).toHaveCount(0);
  });

  test('NpcPage keeps the NPC when connected quests fail', async ({ page }) => {
    const { campaignId, npcId } = seed();
    const QUESTS_URL = `**/api/v1/campaigns/${campaignId}/quests`;

    await page.route(QUESTS_URL, (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));

    await page.goto(`/c/${campaignId}/npcs/${npcId}`);

    // Core content: the NPC heading renders — the page did NOT 404.
    await expect(page.getByRole('heading', { name: NPC_NAME, level: 1 })).toBeVisible();
    await expect(page.getByText('NPC not found')).toHaveCount(0);

    // Auxiliary failure: the Connected card shows an inline alert with Retry.
    const questsAlert = page.getByRole('alert').filter({ hasText: "Couldn't load connected quests." });
    await expect(questsAlert).toBeVisible();
    await expect(questsAlert.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Retry only the quests panel.
    await page.unroute(QUESTS_URL);
    await page.route(QUESTS_URL, (route) => route.continue());
    await questsAlert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load connected quests." })).toHaveCount(0);
  });

  test('LocationPage keeps the location when NPCs fail', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const NPCS_URL = `**/api/v1/campaigns/${campaignId}/npcs`;

    await page.route(NPCS_URL, (route) => route.fulfill({ status: 503, json: { message: 'Unavailable' } }));

    await page.goto(`/c/${campaignId}/locations/${navigation.locationId}`);

    // Core content: the location heading renders — the page did NOT 404.
    await expect(page.getByRole('heading', { name: 'DLRNAV Moon Gate', level: 1 })).toBeVisible();
    await expect(page.getByText('Location not found')).toHaveCount(0);

    // Auxiliary failure: the "Here & connected" card shows an inline alert with Retry.
    const npcsAlert = page.getByRole('alert').filter({ hasText: "Couldn't load NPCs for this location." });
    await expect(npcsAlert).toBeVisible();
    await expect(npcsAlert.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Retry only the NPCs panel.
    await page.unroute(NPCS_URL);
    await page.route(NPCS_URL, (route) => route.continue());
    await npcsAlert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load NPCs for this location." })).toHaveCount(0);
  });
});
