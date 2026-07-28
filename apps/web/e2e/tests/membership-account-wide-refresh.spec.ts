import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

/**
 * Issue #1590 — end-to-end proof of the exact claim the issue makes: a member promoted
 * (or demoted) while they have NO tab open on the affected campaign — and never reload —
 * still sees their new role reflected, because `NotificationsProvider`'s poll (mounted
 * once, account-wide, regardless of which campaign or none is open) now refreshes `/me`
 * when the unread-count response reports `membershipChanged`.
 *
 * Everything after sign-in is a CLIENT-SIDE navigation (`<Link>` clicks only — never
 * `page.goto`/`page.reload`) and the assertion reads the rendered DOM, not a fresh network
 * call — a poll against the live server would trivially show the new role regardless of
 * whether the CLIENT's cached `/me` ever updated, which would prove nothing about this fix.
 *
 * Uses a fresh, disposable campaign + user rather than the shared seed fixtures: this test
 * mutates a membership role, and the seeded player/dm accounts are read by many other
 * specs sharing the same worker's backend. Authenticates the fresh user via a direct API
 * login into that browser context's own cookie jar (`context.request` shares cookies with
 * `page.goto` in the same context) rather than driving the login FORM, which is unrelated
 * to what this test is about and adds a second thing that can flake.
 */
test.describe('account-wide /me refresh on membership change (#1590)', () => {
  test.use({ storageState: stateFor('admin') });

  test('a member promoted with no tab on that campaign sees the new role after a client-side navigation, no reload', async ({
    page,
  }) => {
    const admin = page.request;
    const suffix = Date.now();
    const campaignName = `Role Refresh ${suffix}`;
    const username = `rolerefresh_${suffix}`;
    const password = 'rolerefresh-pw-1';

    const campaignRes = await admin.post('/api/v1/campaigns', { data: { name: campaignName } });
    expect(campaignRes.ok()).toBe(true);
    const campaignId = (await campaignRes.json()).id as number;

    const userRes = await admin.post('/api/v1/users', { data: { username, password } });
    expect(userRes.ok()).toBe(true);
    const userId = (await userRes.json()).id as number;

    const memberRes = await admin.post(`/api/v1/campaigns/${campaignId}/members`, {
      data: { userId, role: 'player' },
    });
    expect(memberRes.ok()).toBe(true);
    const memberId = (await memberRes.json()).id as number;

    // A fresh browser context for the promoted user — deliberately not reusing the
    // admin-authenticated `page`. Logs in via the API directly into this context's cookie
    // jar rather than the login form.
    const userContext = await page.context().browser()!.newContext();
    const login = await userContext.request.post('/api/v1/auth/login', { data: { username, password } });
    expect(login.ok()).toBe(true);
    const userPage = await userContext.newPage();
    await userPage.goto('/');

    // Home dashboard — no campaign open. The tile shows this user's OWN role, sourced from
    // AuthProvider's cached `/me` (HomePage.tsx's CampaignTile), which is exactly what a
    // stale cache would get wrong.
    const tile = userPage.locator('a', { hasText: campaignName }).first();
    await expect(tile).toBeVisible();
    await expect(tile.getByText('Player', { exact: true })).toBeVisible();

    // Promoted from a DIFFERENT identity while the user's only tab sits on the dashboard —
    // the exact scenario #1546 could not close from inside its own module.
    const promote = await admin.patch(`/api/v1/campaigns/${campaignId}/members/${memberId}`, {
      data: { role: 'dm' },
    });
    expect(promote.ok()).toBe(true);

    // Trigger the poll the same way an ordinary user would: navigate somewhere, client-side.
    // NotificationsProvider forces a refetch on every pathname change (see the
    // `location.pathname` effect) — clicking into the campaign is itself that trigger.
    // Let the forced refetch this navigation triggered actually land before navigating
    // again — a second forced refetch fired too soon would abort this one mid-flight
    // (`refreshCount`'s own `force` path cancels an in-flight request), which is a real
    // behavior worth not fighting in this test rather than something to assert on here.
    const unreadCountResponse = userPage.waitForResponse(
      (res) => res.url().includes('/api/v1/notifications/unread-count') && res.status() === 200,
    );
    // The conditional `/me` refresh `unread-count`'s `membershipChanged: true` triggers.
    const meRefreshResponse = userPage.waitForResponse(
      (res) => res.url().endsWith('/api/v1/me') && res.status() === 200,
    );
    await tile.click();
    await userPage.waitForURL((url) => url.pathname === `/c/${campaignId}`);
    await unreadCountResponse;
    await meRefreshResponse;

    // Client-side navigation back to the dashboard — the sidebar's "Switch campaign" link
    // (the in-campaign equivalent of the home logo). No `page.reload()` or `page.goto()`
    // anywhere in this test after the initial sign-in landing — everything from here reads
    // the CLIENT's own re-render.
    await userPage.getByRole('link', { name: 'Switch campaign' }).click();
    await userPage.waitForURL((url) => url.pathname === '/');

    // The role chip on the SAME tile now reads DM — the client's cached memberships were
    // refreshed without a reload, from a tab that was never on this campaign when the
    // promotion happened.
    const tileAfter = userPage.locator('a', { hasText: campaignName }).first();
    await expect(tileAfter.getByText('DM', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(tileAfter.getByText('Player', { exact: true })).toHaveCount(0);

    await userContext.close();
  });
});
