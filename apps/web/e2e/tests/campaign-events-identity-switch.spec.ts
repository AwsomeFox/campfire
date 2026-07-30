import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #1446 review fix (round 6) — `useCampaignEvents.ts` is shared well beyond the
 * encounter run-session page (Layout's `useMembershipLiveSync`, Dashboard, Inventory,
 * Party, the player display, and RunSessionPage's own direct subscription all use it).
 * Its effect used to be keyed only on `[campaignId, resumeEpoch]`. `resumeEpoch` only
 * bumps after a PROVEN 401 (`sessionExpiry.ts`) — it does not cover an AuthProvider `/me`
 * refresh that swaps the signed-in account without an intervening 401 (issue #437's
 * membership-sync BroadcastChannel triggers exactly this kind of refresh, unconditionally,
 * on ANY tab of the account, without navigating away from the current route).
 *
 * Without identity in the key, that kind of account switch left the OLD identity's
 * authenticated SSE connection running: the new account would see a false "never
 * connects" (no restart means no fresh `connected`), and — the serious half — the tab
 * would keep consuming campaign frames delivered on the PREVIOUS account's authenticated
 * request: cross-account data reaching a session that should no longer receive it.
 *
 * This test proves the fix at the actual subscription lifecycle, not by checking a
 * page-local status variable: the FIRST connection to the campaign's events endpoint is
 * left permanently pending (never resolved), the identity is swapped via the real
 * cookie-session mechanism (not dev-auth, which this suite's server never enables), and
 * AuthProvider's refresh is triggered via the SAME cross-tab BroadcastChannel mechanism
 * issue #437 already uses for a real role-change relay — no navigation, no reload. The
 * assertions are on the network layer: the OLD request is aborted (torn down), and a NEW
 * request is issued (re-established) — not merely that a page-local variable reset.
 */
test('an identity change tears down the previous campaign stream and re-establishes it under the new account', async ({
  browser,
}) => {
  const { campaignId } = seed();
  const reader = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
  const page = await reader.newPage();

  const eventsRequestUrls: string[] = [];
  const failedRequestUrls: string[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith(`/api/v1/campaigns/${campaignId}/events`)) eventsRequestUrls.push(req.url());
  });
  page.on('requestfailed', (req) => {
    if (req.url().endsWith(`/api/v1/campaigns/${campaignId}/events`)) failedRequestUrls.push(req.url());
  });

  let releaseFirstConnection: () => void = () => {};
  const firstConnectionHang = new Promise<void>((resolve) => {
    releaseFirstConnection = resolve;
  });
  let connectionAttempts = 0;
  await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
    connectionAttempts += 1;
    if (connectionAttempts === 1) {
      // Left pending for the whole test (released only in cleanup) — this is what lets
      // the assertions below distinguish "torn down" from "never resolved anyway".
      await firstConnectionHang;
      await route.abort('connectionfailed');
    } else {
      await route.continue();
    }
  });

  try {
    // Any authenticated page in this campaign keeps a stream open via Layout's shared
    // useMembershipLiveSync — no encounter needed for this test.
    await page.goto(`/c/${campaignId}/encounters`);
    await expect.poll(() => eventsRequestUrls.length).toBeGreaterThanOrEqual(1);
    expect(failedRequestUrls.length).toBe(0);

    const dmMe = await (await page.request.get('/api/v1/me')).json();

    // Swap the shared session cookie to a DIFFERENT account — the real mechanism, not a
    // dev-auth header override (this suite's server never sets DEV_AUTH).
    await page.request.post('/api/v1/auth/login', { data: CREDS.player });

    // Trigger AuthProvider's /me refresh WITHOUT navigating, using the SAME cross-tab
    // BroadcastChannel relay issue #437 already ships for a real role-change — the
    // refresh now returns the swapped-in (player) identity.
    await page.evaluate((userId: number) => {
      const channel = new BroadcastChannel(`campfire.membership.sync.${userId}`);
      channel.postMessage({ type: 'membership.updated', campaignId: 0, role: 'player' });
      channel.close();
    }, dmMe.user.id);

    // The OLD (still-pending) connection is torn down — not merely a page-local status
    // flip — and a NEW one is established under the new credentials.
    await expect.poll(() => failedRequestUrls.length).toBeGreaterThanOrEqual(1);
    await expect.poll(() => eventsRequestUrls.length).toBeGreaterThanOrEqual(2);
  } finally {
    releaseFirstConnection();
    await reader.close();
  }
});
