import { expect, test, type Request } from '@playwright/test';
import { stateFor } from './seed';

const TOKEN = `cf_cast_${'a'.repeat(48)}`;

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
          campaign: { id: 7, name: 'Cast-Safe Campaign', sessionCount: 0, ruleSystem: '' },
          currentLocation: null,
          quests: [],
          npcs: [],
          locations: [],
          characters: [],
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

    await page.goto(`/cast/7/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Cast-Safe Campaign' })).toBeVisible();
    await expect(page.getByTestId('cf-cockpit')).toHaveCount(0);
    expect(normalCampaignCalls).toEqual([]);
    expect(castCalls.some((url) => url.endsWith(`/api/v1/cast/${TOKEN}/summary`))).toBe(true);

    await page.getByRole('button', { name: 'Exit kiosk' }).click();
    await expect(page.getByRole('dialog', { name: 'Exit kiosk mode?' })).toBeVisible();
    await page.getByLabel('Exit PIN').fill('123456');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect.poll(() => exitVerified).toBe(true);
  });
});
