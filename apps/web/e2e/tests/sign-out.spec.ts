import { expect, test, type Page } from '@playwright/test';
import { seed } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #506 — Sign out must immediately clear authenticated UI and redirect,
 * even on a shared device and even when the server round-trip fails.
 *
 * Each test signs in fresh through the UI rather than reusing the shared
 * `dm.json` storageState: signing out for real revokes that session token
 * server-side (issue #506's whole point), and the shared storageState is a
 * single captured session reused by every other spec in the suite — killing
 * it here would break them. A fresh login gets its own independent session.
 *
 * Coverage:
 *   (a) clicking Sign out removes protected DOM and lands on /login with the
 *       route REPLACED (no lingering history entry to bounce back into);
 *   (b) the sign-in heading receives focus and an assertive live region
 *       announces the sign-out, for keyboard/screen-reader users;
 *   (c) revisiting the just-signed-out campaign URL (the shared-device case —
 *       the next person tries Back, a bookmark, or a saved link) is bounced to
 *       /login, proving the server session was actually invalidated, not just
 *       the client UI;
 *   (d) a server failure on /auth/logout does not block the client-side clear
 *       + redirect — the account is gone from THIS device either way.
 */

async function signInAsDm(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(CREDS.dm.username);
  await page.getByLabel('Password').fill(CREDS.dm.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test.describe('sign out (issue #506)', () => {
  test('clears protected UI, replaces history with /login, announces + focuses the heading', async ({ page }) => {
    const { campaignId } = seed();
    await signInAsDm(page);
    await page.goto(`/c/${campaignId}`);
    // Prove we're authed in a campaign with DM-only chrome visible before sign-out.
    await expect(page.getByText('Dungeon master', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.waitForURL('**/login');
    // Protected DOM is gone — the DM-only sidebar section no longer exists anywhere in the page.
    await expect(page.getByText('Dungeon master', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Accessible confirmation: focus lands on the heading, and the assertive
    // live region carries a "Signed out" announcement for screen readers.
    await expect(page.locator('#login-title')).toBeFocused();
    await expect(page.locator('[role="alert"]').filter({ hasText: 'Signed out' })).toHaveCount(1);

    // History was replaced, not pushed — Back must not return to the campaign.
    await page.goBack();
    await expect(page).not.toHaveURL(new RegExp(`/c/${campaignId}(/|$)`));
  });

  test('the signed-out session is actually invalidated server-side (shared-device re-access)', async ({ page }) => {
    const { campaignId } = seed();
    await signInAsDm(page);
    await page.goto(`/c/${campaignId}`);
    await expect(page.getByText('Dungeon master', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');

    // The next person at this device tries the campaign URL directly (history,
    // a bookmark, a saved link) — the server session is gone, so this must
    // bounce to /login rather than render the prior account's campaign data.
    await page.goto(`/c/${campaignId}`);
    await page.waitForURL('**/login');
    await expect(page.getByText('Dungeon master', { exact: true })).toHaveCount(0);
  });

  test('a failed /auth/logout server call still clears client state and redirects', async ({ page }) => {
    const { campaignId } = seed();
    await signInAsDm(page);
    await page.goto(`/c/${campaignId}`);
    await expect(page.getByText('Dungeon master', { exact: true })).toBeVisible();

    await page.route('**/api/v1/auth/logout', async (route) => {
      await route.fulfill({ status: 500, json: { message: 'Simulated server failure' } });
    });

    await page.getByRole('button', { name: 'Sign out' }).click();

    // Client-side state clears and the redirect happens regardless of the
    // server error — there is nothing left client-side to roll back.
    await page.waitForURL('**/login');
    await expect(page.getByText('Dungeon master', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
