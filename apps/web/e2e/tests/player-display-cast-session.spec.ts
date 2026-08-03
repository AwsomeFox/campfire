import { expect, test, type Page, type Request } from '@playwright/test';
import { stateFor } from './seed';

const TOKEN = `cf_cast_${'a'.repeat(48)}`;

/** Client-side navigation — pushState + popstate is exactly what a client-side
 * navigation does to createBrowserRouter, reusing the mounted route element
 * rather than remounting it the way `page.goto()` would. See
 * `ai-table-campaign-switch.spec.ts` (#572) for the same technique. */
async function navigateClientSide(page: Page, to: string): Promise<void> {
  await page.evaluate((href) => {
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, to);
}
const CAST_PARTY = [{
  id: 1,
  name: 'Ember',
  species: 'Human',
  className: 'Fighter',
  level: 3,
  status: 'active',
  ac: 16,
  hpCurrent: 12,
  hpMax: 12,
  conditions: [],
  portraitUrl: null,
}];

function expectCastFetchWithoutCookies(request: Request) {
  expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`);
  expect(request.headers().cookie ?? '').toBe('');
}

test.describe('Player Display cast sessions', () => {
  test.use({ storageState: stateFor('dm') });

  test('shared-device route uses cast endpoints and gates exit with PIN', async ({ page }) => {
    const normalCampaignCalls: string[] = [];
    const castCalls: string[] = [];
    let exitVerified = false;

    await page.route('**/api/v1/campaigns/**', (route) => {
      normalCampaignCalls.push(route.request().url());
      return route.abort();
    });
    await page.route(`**/api/v1/cast/${TOKEN}/summary`, (route) => {
      castCalls.push(route.request().url());
      expectCastFetchWithoutCookies(route.request());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          campaign: { id: 7, name: 'Cast-Safe Campaign', sessionCount: 0, latestSessionNumber: 0, ruleSystem: '' },
          currentLocation: null,
          quests: [],
          npcs: [],
          locations: [],
          characters: [],
          party: CAST_PARTY,
          sessions: [],
          encounters: [],
          timeline: [],
          treasury: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
          inventoryCount: 0,
          commentCount: 0,
          inProgressSession: null,
          nextSession: null,
          openInboxCount: 0,
        }),
      });
    });
    await page.route(`**/api/v1/cast/${TOKEN}/encounters?status=running`, (route) => {
      castCalls.push(route.request().url());
      expectCastFetchWithoutCookies(route.request());
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    // Issue #1908: the display fails safe (renders the curtain) until the first
    // safety poll actually succeeds, so this route must resolve for any test that
    // interacts with the page underneath it.
    await page.route(`**/api/v1/cast/${TOKEN}/safety`, (route) => {
      castCalls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) });
    });
    await page.route(`**/api/v1/cast/${TOKEN}/exit`, (route) => {
      castCalls.push(route.request().url());
      expectCastFetchWithoutCookies(route.request());
      expect(route.request().postDataJSON()).toEqual({ pin: '123456' });
      exitVerified = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.addInitScript(() => localStorage.setItem('cf.screen.scene.7', 'party'));
    await page.goto(`/cast/7/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Cast-Safe Campaign' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Party' }).getByText('Ember', { exact: true })).toBeVisible();
    await expect(page.getByTestId('cf-cockpit')).toHaveCount(0);
    expect(normalCampaignCalls).toEqual([]);
    expect(castCalls.some((url) => url.endsWith(`/api/v1/cast/${TOKEN}/summary`))).toBe(true);

    await page.getByRole('button', { name: 'Exit kiosk' }).click();
    const exitDialog = page.getByRole('dialog', { name: 'Exit kiosk mode?' });
    await expect(exitDialog).toBeVisible();

    // The operator control stack auto-hides (opacity:0 + pointer-events:none + an
    // `inert` attribute) after 3.5s without pointer/focus activity. The PIN dialog
    // must NOT be nested inside it: once focus sits in the dialog rather than the
    // stack, the stack hides — and a nested dialog would be dragged invisible and
    // non-interactive with it. Sit still past the hide window and prove otherwise.
    await page.waitForTimeout(4500);
    await expect(page.locator('.cf-screen-control-stack')).toHaveAttribute('data-visible', 'false');
    await expect(exitDialog).toBeVisible();
    await expect(page.getByLabel('Exit PIN')).toBeEnabled();
    // Escape-to-close comes from the shared useDialog hook; reopen to continue.
    await page.keyboard.press('Escape');
    await expect(exitDialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Exit kiosk' }).click();
    await expect(exitDialog).toBeVisible();

    await page.getByLabel('Exit PIN').fill('123456');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect.poll(() => exitVerified).toBe(true);
  });

  /**
   * Issue #547's core claim is that redaction is a SERVER boundary. The battle map is
   * the one Player Display surface whose bytes come from an <img>, which cannot carry
   * an Authorization header — so if it pointed at /encounters/:id/map, this
   * DM-cookie-bearing browser would be served the unfogged SOURCE map.
   */
  test('map scene reads pixels through the cast capability, never the DM map route', async ({ page }) => {
    const encounterMapCalls: string[] = [];
    const castMapCalls: string[] = [];
    const encounterId = 42;
    const encounter = {
      id: encounterId,
      campaignId: 7,
      name: 'Cast Fight',
      status: 'running',
      round: 1,
      mapAttachmentId: 9,
      updatedAt: '2026-01-01T00:00:00.000Z',
      combatants: [],
      aoe: [],
      fog: { enabled: true, revealed: [{ x: 0, y: 0, w: 50, h: 100 }] },
    };

    await page.route('**/api/v1/campaigns/**', (route) => route.abort());
    // Any hit on the cookie-authenticated map route is a failure of the boundary.
    await page.route('**/api/v1/encounters/*/map*', (route) => {
      encounterMapCalls.push(route.request().url());
      return route.abort();
    });
    // Issue #604's responsive ladder hangs off a SUB-path of that route, and a
    // Playwright `*` does not cross `/` — so the glob above would miss it. The
    // manifest and every srcset rung authenticate from the session COOKIE, so on
    // this DM-cookie-bearing kiosk a single rung would be served the unfogged
    // SOURCE map. A cast display must therefore fetch no manifest at all.
    await page.route('**/api/v1/encounters/*/map/**', (route) => {
      encounterMapCalls.push(route.request().url());
      return route.abort();
    });
    await page.route(`**/api/v1/cast/${TOKEN}/encounters/${encounterId}/map*`, (route) => {
      castMapCalls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(TRANSPARENT_PNG_BASE64, 'base64') });
    });
    await page.route(`**/api/v1/cast/${TOKEN}/summary`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(castSummary()) }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/encounters?status=running`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([encounter]) }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/encounters/${encounterId}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(encounter) }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/safety`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
    );

    await page.addInitScript(() => {
      window.localStorage.setItem('cf.screen.scene.7', 'map');
    });
    await page.goto(`/cast/7/${TOKEN}`);
    await expect(page.getByTestId('cf-scene-map-body')).toBeVisible();
    await expect.poll(() => castMapCalls.length).toBeGreaterThan(0);
    expect(encounterMapCalls).toEqual([]);

    // Issue #604: the board renders through the capability URL alone. No `srcset`
    // may be emitted here — every rung would resolve to the cookie-authenticated
    // route, i.e. the DM's unfogged source map on a screen the table can see.
    const castMap = page.getByRole('img', { name: 'Battle map' });
    await expect(castMap).toBeVisible();
    expect(await castMap.getAttribute('srcset')).toBeNull();
    expect(await castMap.getAttribute('sizes')).toBeNull();
    expect(await castMap.getAttribute('src')).toContain(`/cast/${TOKEN}/`);

    // A kiosk gets reloaded and navigated back to constantly; neither may fall back
    // to the authenticated route or to a stale cached DM payload.
    await page.reload();
    await expect(page.getByTestId('cf-scene-map-body')).toBeVisible();
    expect(encounterMapCalls).toEqual([]);
    expect(await page.getByRole('img', { name: 'Battle map' }).getAttribute('srcset')).toBeNull();
  });

  /**
   * Issue #1908 — a cast client has no member identity, so it cannot read the
   * member-scoped `GET /campaigns/:id/safety` behind `useTableSafety`. It must still
   * blank the fight when the table raises an X-Card: this proves the anonymous
   * `/cast/:token/safety` poll drives the same overlay the authed route uses.
   */
  test('cast display blanks on an X-Card safety hold and restores on release', async ({ page }) => {
    let holdActive = false;
    const safetyCalls: Request[] = [];

    await page.route('**/api/v1/campaigns/**', (route) => route.abort());
    await page.route(`**/api/v1/cast/${TOKEN}/summary`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(castSummary()) }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/encounters?status=running`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/safety`, (route) => {
      safetyCalls.push(route.request());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: holdActive }),
      });
    });

    await page.addInitScript(() => window.localStorage.setItem('cf.screen.scene.7', 'party'));
    await page.goto(`/cast/7/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Cast-Safe Campaign' })).toBeVisible();

    // Fetched on mount, before the first poll tick — proves the safety projection
    // itself carries no more than `{ active }` over the wire (no cookies either,
    // same anonymity contract as every other cast route).
    await expect.poll(() => safetyCalls.length).toBeGreaterThan(0);
    expectCastFetchWithoutCookies(safetyCalls[0]);
    await expect(page.getByTestId('safety-display-overlay')).toHaveCount(0);

    // Raising the hold must blank the display within the acceptance criteria's 15s
    // bound; the page polls every 5s, comfortably inside it. The overlay is a
    // `position: fixed` full-viewport scrim (same markup the authed route renders),
    // so it visually covers the scene beneath it without unmounting it.
    holdActive = true;
    await expect(page.getByTestId('safety-display-overlay')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('safety-display-overlay')).toContainText('The table is paused.');

    // Releasing restores the scene.
    holdActive = false;
    await expect(page.getByTestId('safety-display-overlay')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('region', { name: 'Party' }).getByText('Ember', { exact: true })).toBeVisible();
  });

  /**
   * Issue #1908 rework, round 4 — "no hold" and "never successfully checked"
   * are different states, and only the confirmed former may render as an open
   * display. Before the first `/safety` poll actually resolves, the page
   * cannot yet distinguish "no hold" from "don't know" — it must fail safe
   * and render as if a hold were active, not default to the open scene.
   */
  test('cast display shows the curtain until the first safety poll succeeds, even when no hold is active', async ({ page }) => {
    let releaseSafety!: () => void;
    const safetyGate = new Promise<void>((resolve) => {
      releaseSafety = resolve;
    });

    await page.route('**/api/v1/campaigns/**', (route) => route.abort());
    await page.route(`**/api/v1/cast/${TOKEN}/summary`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(castSummary()) }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/encounters?status=running`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/safety`, async (route) => {
      await safetyGate; // hold the response open until the test explicitly releases it
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: false }),
      });
    });

    await page.addInitScript(() => window.localStorage.setItem('cf.screen.scene.7', 'party'));
    await page.goto(`/cast/7/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Cast-Safe Campaign' })).toBeVisible();

    // The first /safety poll is still in flight — no hold is actually active,
    // but that isn't known yet. The display must fail safe rather than
    // assume the open scene.
    await expect(page.getByTestId('safety-display-overlay')).toBeVisible();

    // Once the poll actually succeeds and confirms no hold, the curtain lifts.
    releaseSafety();
    await expect(page.getByTestId('safety-display-overlay')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Party' }).getByText('Ember', { exact: true })).toBeVisible();
  });

  /**
   * Issue #1908 rework, round 6 — `/cast/:campaignId/:token` is a single
   * unkeyed route element, so a client-side transition between two different
   * cast identities REUSES the mounted `PlayerDisplayPage`, not remounts it.
   * The prior campaign's last-known safety state must not survive that
   * transition: a display that last confirmed "no hold" on campaign A must
   * fail safe (show the curtain) for campaign B until B's OWN poll succeeds
   * — even if B's hold is already active and its poll is slow to confirm it.
   */
  test('safety knowledge resets to unknown on a client-side cast identity change, even when the new hold is already active', async ({ page }) => {
    const CAMPAIGN_B = 8;
    const TOKEN_B = `cf_cast_${'b'.repeat(48)}`;
    let releaseSafetyB!: () => void;
    const safetyBGate = new Promise<void>((resolve) => {
      releaseSafetyB = resolve;
    });

    await page.route('**/api/v1/campaigns/**', (route) => route.abort());

    // Campaign A: confirmed no hold.
    await page.route(`**/api/v1/cast/${TOKEN}/summary`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(castSummary()) }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/encounters?status=running`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route(`**/api/v1/cast/${TOKEN}/safety`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
    );

    // Campaign B: its hold is ALREADY active, but the safety poll is slow to
    // confirm it — the case that matters is what the display shows in the
    // gap, not just the eventual correct value.
    await page.route(`**/api/v1/cast/${TOKEN_B}/summary`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(castSummary(CAMPAIGN_B, 'Second Cast Campaign')),
      }),
    );
    await page.route(`**/api/v1/cast/${TOKEN_B}/encounters?status=running`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route(`**/api/v1/cast/${TOKEN_B}/safety`, async (route) => {
      await safetyBGate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: true }) });
    });

    await page.addInitScript(() => {
      window.localStorage.setItem('cf.screen.scene.7', 'party');
      window.localStorage.setItem('cf.screen.scene.8', 'party');
    });
    await page.goto(`/cast/7/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Cast-Safe Campaign' })).toBeVisible();
    await expect(page.getByTestId('safety-display-overlay')).toHaveCount(0);

    await navigateClientSide(page, `/cast/${CAMPAIGN_B}/${TOKEN_B}`);
    await expect(page.getByRole('heading', { name: 'Second Cast Campaign' })).toBeVisible();

    // Campaign A's confirmed "no hold" must not carry over: campaign B's own
    // poll hasn't resolved yet, so the display must fail safe.
    await expect(page.getByTestId('safety-display-overlay')).toBeVisible();

    // Confirms this isn't just the fail-safe default settling into the
    // correct value by coincidence — B's hold really is active.
    releaseSafetyB();
    await expect(page.getByTestId('safety-display-overlay')).toBeVisible();
    await expect(page.getByTestId('safety-display-overlay')).toContainText('The table is paused.');
  });
});

/** 1x1 transparent PNG — the map bytes' contents are irrelevant, only their source is. */
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function castSummary(id = 7, name = 'Cast-Safe Campaign') {
  return {
    campaign: { id, name, sessionCount: 0, latestSessionNumber: 0, ruleSystem: '' },
    currentLocation: null,
    quests: [],
    npcs: [],
    locations: [],
    characters: [],
    party: CAST_PARTY,
    sessions: [],
    encounters: [],
    timeline: [],
    treasury: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    inventoryCount: 0,
    commentCount: 0,
    inProgressSession: null,
    nextSession: null,
    openInboxCount: 0,
  };
}
