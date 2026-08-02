import { expect, test, type Page } from '@playwright/test';
import { CREDS } from '../global-setup';
import { seed } from './seed';

/**
 * Issue #573 — AI transcript privacy across identities on one browser.
 *
 * The unit spec (`ai-transcript-privacy.unit.spec.ts`) pins the storage contract and the
 * hydration ordering. This one pins the behaviour a player can actually observe on a
 * shared device, through the real app: the grant defaults to private, a transcript kept
 * under it does NOT survive sign-out, the next account does not inherit it, and losing
 * access to a campaign drops the local copy.
 *
 * Each test signs in through the UI rather than reusing a captured storageState, because
 * a real sign-out revokes the session server-side and would poison the shared fixtures.
 */

const TRANSCRIPT_PREFIX = 'cf.aiDm.';

function driverAiDmRoutes(campaignId: number) {
  return {
    campaignId,
    mode: 'driver',
    enabled: true,
    model: 'test',
    instructions: '',
    tokenBudget: 10_000,
    tokensUsed: 0,
    turnCount: 0,
    lastTurnAt: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

/**
 * Put the campaign in Driver mode for this browser only, and keep the authoritative
 * transcript EMPTY. An empty server transcript is the sharp version of the test: anything
 * the page renders must have come from local storage, so an inherited line cannot be
 * mistaken for the server legitimately serving shared table history.
 */
async function mockDriverTable(page: Page, campaignId: number, transcriptStatus = 200) {
  const seat = driverAiDmRoutes(campaignId);
  await page.route(`**/api/v1/campaigns/${campaignId}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if ((path.endsWith('/ai-dm/stream') || path.endsWith('/events'))) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    }
    if (path.endsWith('/ai-dm/seat') || (path.endsWith('/ai-dm') && route.request().method() === 'GET')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(seat) });
    }
    if (path.endsWith('/ai-dm/session')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          campaignId,
          status: 'active',
          state: 'running',
          scene: null,
          lastNarration: null,
          lastTurnAt: null,
          turnCount: 0,
          stuck: null,
          levers: [],
          actingDm: null,
          vote: null,
          takeoverRequestedBy: null,
        }),
      });
    }
    if (path.endsWith('/ai-dm/message') && route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (path.endsWith('/ai-dm/transcript')) {
      if (transcriptStatus !== 200) {
        return route.fulfill({
          status: transcriptStatus,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Not a member of this campaign' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, hasMore: false, nextCursor: null }),
      });
    }
    return route.fallback();
  });
}

async function signIn(page: Page, who: keyof typeof CREDS) {
  await page.goto('/login');
  const localToggle = page.getByRole('button', { name: /local account|username and password/i });
  if (await localToggle.first().isVisible().catch(() => false)) {
    await localToggle.first().click();
  }
  await page.getByLabel('Username').fill(CREDS[who].username);
  await page.getByLabel('Password', { exact: true }).fill(CREDS[who].password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Every AI-DM local key currently in this browser profile, whatever the user/campaign. */
function aiDmKeys(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
    return out;
  }, TRANSCRIPT_PREFIX);
}

const rememberToggle = (page: Page) =>
  page.getByRole('checkbox', { name: 'Remember this transcript on this device' });

async function openTable(page: Page, campaignId: number) {
  await page.goto(`/c/${campaignId}/table`);
  await expect(page.getByRole('log', { name: 'Table transcript' })).toBeVisible();
}

test.describe('AI transcript privacy (#573)', () => {
  // #1592 — block the PWA service worker. Root cause of the reported flake
  // (`ai-transcript-privacy.spec.ts:154` timing out on `getByRole('log', { name: 'Table
  // transcript' })`): `vite.config.ts` registers API GET routes with workbox runtime
  // caching (NetworkOnly for sensitive exclusions, NetworkFirst for allowlisted JSON/images).
  // Once the SW has installed and taken control of THIS page — it
  // does not control the tab that registered it, only the NEXT navigation onward — a `fetch`
  // the page issues is intercepted by the SW's own `fetch` listener and re-issued from the
  // service-worker thread, not the document. `page.route()` only intercepts requests the
  // PAGE/frame initiates; a request replayed by the SW is a different initiator and sails
  // straight past it to the real server.
  //
  // This test signs in as two different accounts across THREE full navigations
  // (`openTable`/`signIn` both `page.goto`), which is enough time for the SW's install →
  // activate → claim sequence to complete partway through. On the run where it does, the
  // THIRD `openTable`'s `GET **/api/v1/campaigns/${campaignId}/**` bypasses
  // `mockDriverTable`'s route entirely and returns the campaign's real (non-driver) seat —
  // confirmed by capturing the
  // response body during a failing run: `{"mode":"co_dm",...}` instead of the mocked
  // `{"mode":"driver",...}`. The app then correctly renders the Co-DM gate instead of the
  // transcript for data it genuinely received; nothing in `AiTablePage`/`RunSessionPage`
  // gates the transcript on `/safety`, `/mentions`, or any other campaign query (`useAiDmSeat`
  // / `useAiDmSession` depend on nothing but `campaignId`), and stalling those endpoints WITH
  // the service worker blocked has no effect on the transcript at all — verified directly, see
  // the PR for #1592.
  //
  // Any spec that establishes `page.route` mocks and then does more than one full navigation
  // (especially across a sign-out/sign-in identity switch, which the OTHER `ai-*` specs with
  // comparable navigation counts do not) needs this, per the SAME pattern already used by
  // `confirm-dialog-pending-labels.spec.ts`, `notifications.spec.ts`, and others.
  test.use({ serviceWorkers: 'block' });

  test('the device grant defaults to off and writes nothing until it is given', async ({ page }) => {
    const { campaignId } = seed();
    await mockDriverTable(page, campaignId);
    await signIn(page, 'player');
    await openTable(page, campaignId);

    // The private option is the DEFAULT, not a setting the player has to discover. A
    // transcript records what everyone at the table said; keeping it in a shared browser
    // has to be something a player asks for.
    await expect(rememberToggle(page)).toHaveAttribute('aria-checked', 'false');

    await page.getByTestId('ai-table-composer').getByRole('textbox', { name: 'Your action' }).fill('I listen at the door.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('log', { name: 'Table transcript' })).toContainText('I listen at the door.');

    // On screen, but not on disk.
    expect(await aiDmKeys(page)).toEqual([]);

    await rememberToggle(page).click();
    await expect(rememberToggle(page)).toHaveAttribute('aria-checked', 'true');
    // Turning it on persists what is already on screen rather than waiting for the next line.
    await expect.poll(async () => (await aiDmKeys(page)).some((k) => k.includes('transcript'))).toBe(true);

    // And withdrawing it erases the stored copy, not just future writes.
    await rememberToggle(page).click();
    await expect.poll(async () => (await aiDmKeys(page)).some((k) => k.includes('transcript'))).toBe(false);
  });

  test('user A → sign out → user B: nothing of A survives, and B inherits nothing', async ({ page }) => {
    const { campaignId } = seed();
    await mockDriverTable(page, campaignId);

    // --- user A opts in and leaves a line in local storage ---------------------
    await signIn(page, 'player');
    await openTable(page, campaignId);
    await rememberToggle(page).click();
    await page.getByTestId('ai-table-composer').getByRole('textbox', { name: 'Your action' }).fill('A private thing user A typed.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('log', { name: 'Table transcript' })).toContainText('A private thing user A typed.');
    await expect.poll(async () => (await aiDmKeys(page)).length).toBeGreaterThan(0);

    // A reload proves the cache is genuinely being read back, so the sign-out assertion
    // below is about removal and not about the cache never having worked.
    await openTable(page, campaignId);
    await expect(page.getByRole('log', { name: 'Table transcript' })).toContainText('A private thing user A typed.');

    // --- sign out --------------------------------------------------------------
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/login'));
    // CLEARED, not merely namespaced away: a per-user key would leave A's words on this
    // disk for anyone with devtools. The grant goes too — it names a user of this browser.
    expect(await aiDmKeys(page)).toEqual([]);

    // --- user B signs in on the same browser -----------------------------------
    await signIn(page, 'dm');
    await openTable(page, campaignId);
    await expect(page.getByRole('log', { name: 'Table transcript' })).not.toContainText('A private thing user A typed.');
    // B starts from the private default too — A's grant must not carry over as consent.
    await expect(rememberToggle(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('a transcript stored under another user’s key is never read', async ({ page }) => {
    const { campaignId } = seed();
    await mockDriverTable(page, campaignId);
    await signIn(page, 'player');

    // Forge a cache belonging to a DIFFERENT user id, with this viewer's grant held so the
    // opt-in check cannot be what saves us — the namespace has to. This is the quarantine
    // half of the fix, independent of the clear-on-logout half.
    const meResponse = await page.request.get('/api/v1/me');
    const myUserId: number = (await meResponse.json()).user.id;
    const otherUserId = myUserId + 1000;
    await page.evaluate(
      ({ mine, other, cid }) => {
        localStorage.setItem(`cf.aiDm.remember.v1.u${mine}`, '1');
        localStorage.setItem(`cf.aiDm.remember.v1.u${other}`, '1');
        localStorage.setItem(
          `cf.aiDm.transcript.v3.u${other}.table.${cid}`,
          JSON.stringify({
            entries: [
              { id: 'leak-1', kind: 'player', memberName: 'Someone Else', text: 'Line from another account.', at: '2026-07-22T10:00:00.000Z' },
            ],
          }),
        );
      },
      { mine: myUserId, other: otherUserId, cid: campaignId },
    );

    await openTable(page, campaignId);
    await expect(page.getByRole('log', { name: 'Table transcript' })).not.toContainText('Line from another account.');
  });

  test('losing access to the campaign drops the local copy (403 on the next read)', async ({ page }) => {
    const { campaignId } = seed();
    // Membership removal and account disable are SERVER-side events with no push channel.
    // The existing failure path that means "you may no longer see this" is the next
    // transcript read being refused — so that is what clears the cache, rather than a new
    // channel invented for the purpose.
    await mockDriverTable(page, campaignId);
    await signIn(page, 'player');
    await openTable(page, campaignId);
    await rememberToggle(page).click();
    await page.getByTestId('ai-table-composer').getByRole('textbox', { name: 'Your action' }).fill('Still a member here.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await aiDmKeys(page)).some((k) => k.includes('transcript'))).toBe(true);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockDriverTable(page, campaignId, 403);
    await page.goto(`/c/${campaignId}/table`);

    await expect.poll(async () => (await aiDmKeys(page)).some((k) => k.includes('transcript')), {
      timeout: 15_000,
    }).toBe(false);
  });
});
