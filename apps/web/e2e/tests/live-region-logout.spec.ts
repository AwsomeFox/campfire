import { expect, test, type Page } from '@playwright/test';
import { CREDS } from '../global-setup';
import { seed } from './seed';

/**
 * Issue #434 — encounter live-region text must not survive sign-out into the
 * login DOM, nor carry into another user's session on the same device.
 *
 * Each test signs in through the UI (not the shared storageState): a real
 * sign-out revokes that session server-side, and reusing dm.json would poison
 * the rest of the suite.
 *
 * Note: issue #506 announces an assertive "Signed out" confirmation on the
 * login page after the encounter wipe — assertions below allow that while
 * rejecting prior campaign text.
 */

interface CampfireE2EWindow extends Window {
  __CAMPFIRE_E2E__?: {
    announce?: (message: string, options?: { assertive?: boolean }) => void;
    clearAnnouncements?: () => void;
  };
}

/** Opt-in sentinel required with navigator.webdriver for the announcer bridge. */
async function ensureE2EBridgeOptIn(page: Page) {
  await page.addInitScript(() => {
    const w = window as CampfireE2EWindow;
    if (w.__CAMPFIRE_E2E__ == null) w.__CAMPFIRE_E2E__ = {};
  });
}

async function signIn(page: Page, who: keyof typeof CREDS) {
  await ensureE2EBridgeOptIn(page);
  await page.goto('/login');
  // OIDC-capable servers collapse local auth behind a disclosure; open it when present.
  const localToggle = page.getByRole('button', { name: /local account|username and password/i });
  if (await localToggle.first().isVisible().catch(() => false)) {
    await localToggle.first().click();
  }
  await page.getByLabel('Username').fill(CREDS[who].username);
  await page.getByLabel('Password', { exact: true }).fill(CREDS[who].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

function politeRegion(page: Page) {
  return page.locator('div.sr-only[aria-live="polite"]');
}

function assertiveRegion(page: Page) {
  return page.locator('div.sr-only[aria-live="assertive"]');
}

async function seedEncounterAnnouncement(page: Page) {
  const { campaignId, encounterId } = seed();
  await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
  await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();

  // Seed via the Announcer React state (not a bare DOM write) so clear() must
  // actually reset provider state for the assertion to pass. Announcer paints
  // on rAF after blanking the node — wait a frame before asserting.
  // Bridge is namespaced under window.__CAMPFIRE_E2E__ and gated to automation.
  await page.waitForFunction(
    () => typeof (window as CampfireE2EWindow).__CAMPFIRE_E2E__?.announce === 'function',
  );
  await page.evaluate(() => {
    const announce = (window as CampfireE2EWindow).__CAMPFIRE_E2E__?.announce;
    if (!announce) throw new Error('Announce bridge missing');
    announce("Round 1 — Goblin Boss's turn");
    announce('Encounter secret leak', { assertive: true });
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(politeRegion(page)).toHaveText(/Round 1/);
  await expect(assertiveRegion(page)).toHaveText(/Encounter secret leak/);
  return { campaignId };
}

test.describe('live-region clear on logout / identity change (issue #434)', () => {
  test('sign out clears campaign announcements from the login DOM', async ({ page }) => {
    await signIn(page, 'dm');
    await seedEncounterAnnouncement(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');

    await expect(politeRegion(page)).toHaveText('');
    // #506 may place an assertive "Signed out" confirmation — prior campaign
    // text must still be gone.
    await expect(assertiveRegion(page)).not.toContainText('Encounter secret leak');
    await expect(assertiveRegion(page)).not.toContainText(/Round 1/);
    await expect(page.locator('body')).not.toContainText("Goblin Boss's turn");
    await expect(page.locator('body')).not.toContainText('Encounter secret leak');
  });

  test('sign out then sign in as another user keeps live regions empty of prior campaign text', async ({
    page,
  }) => {
    await signIn(page, 'dm');
    const { campaignId } = await seedEncounterAnnouncement(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');
    await expect(politeRegion(page)).toHaveText('');
    await expect(assertiveRegion(page)).not.toContainText('Encounter secret leak');

    await signIn(page, 'player');
    // Player lands authed — prior DM encounter text must not reappear in the
    // app-root live regions (AnnounceProvider outlives the router). The #506
    // "Signed out" assertive confirmation must also be gone once /login unmounts
    // / AuthedLayout mounts (first-mount scope clear).
    await expect(politeRegion(page)).toHaveText('');
    await expect(assertiveRegion(page)).toHaveText('');
    await expect(assertiveRegion(page)).not.toContainText('Signed out');
    await expect(assertiveRegion(page)).not.toContainText('Encounter secret leak');
    await expect(assertiveRegion(page)).not.toContainText(/Round 1/);
    await expect(page.locator('body')).not.toContainText("Goblin Boss's turn");
    await expect(page.locator('body')).not.toContainText('Encounter secret leak');

    // Same campaign under the new identity still starts with a clean announcer.
    await page.goto(`/c/${campaignId}`);
    await expect(politeRegion(page)).toHaveText('');
    await expect(assertiveRegion(page)).not.toContainText(/Round 1/);
    await expect(politeRegion(page)).not.toContainText(/Round 1/);
  });
});
