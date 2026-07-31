import { expect, test, type Request } from '@playwright/test';
import { stateFor } from './seed';

const TOKEN = `cf_cast_${'a'.repeat(48)}`;
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
});

/** 1x1 transparent PNG — the map bytes' contents are irrelevant, only their source is. */
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function castSummary() {
  return {
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
  };
}
