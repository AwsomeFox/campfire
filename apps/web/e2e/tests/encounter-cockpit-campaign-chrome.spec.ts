/**
 * Campaign-wide interrupts stay reachable over the encounter cockpit.
 *
 * `Layout.tsx` mounts the participant safety hold (#599) and a player's check-request
 * prompts (#415) outside the routed page, precisely so they reach EVERY campaign route.
 * The cockpit is `position: fixed; inset: 0` with an opaque background, so it painted
 * over both: an active hold was invisible and the "pause the table" control could not
 * be clicked while combat was on screen. `useImmersiveChromeInset` publishes how far
 * down that chrome reaches and the shell insets its own top by it.
 *
 * These assertions are deliberately about HIT-TESTING, not visibility. The bug did not
 * hide the elements — `toBeVisible()` passed the whole time, because they were rendered
 * at their normal size underneath an opaque overlay. Only `elementFromPoint` (and an
 * actual click) tells the two states apart.
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { stateFor } from './seed';

type ChromeProbe = {
  present: boolean;
  /** What the browser would actually deliver a click at the element's centre to. */
  coveredByCockpit: boolean;
  /** The cockpit must begin below the chrome, never on top of it. */
  cockpitTop: number;
  chromeBottom: number;
};

async function probe(page: Page, testId: string): Promise<ChromeProbe> {
  return page.evaluate((id) => {
    const chrome = document.querySelector(`[data-testid="${id}"]`);
    const shell = document.querySelector('.cf-vtt');
    if (!(chrome instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
      return { present: false, coveredByCockpit: false, cockpitTop: 0, chromeBottom: 0 };
    }
    const rect = chrome.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    );
    return {
      present: true,
      coveredByCockpit: Boolean(hit?.closest('.cf-vtt')),
      cockpitTop: Math.round(shell.getBoundingClientRect().top),
      chromeBottom: Math.round(rect.bottom),
    };
  }, testId);
}

/**
 * Wait for the inset to settle, then hand back the measurements.
 *
 * The publish is deliberately coalesced onto one rAF tick (see the hook), so the frame
 * in which the safety banner first paints can still carry the previous inset. Polling
 * asserts the settled layout instead of racing that tick — and still fails outright if
 * the cockpit never moves, which is the regression this file exists for.
 */
async function settledProbe(page: Page, testId: string): Promise<ChromeProbe> {
  await expect
    .poll(async () => {
      const current = await probe(page, testId);
      return current.present && !current.coveredByCockpit && current.cockpitTop >= current.chromeBottom;
    })
    .toBe(true);
  return probe(page, testId);
}

/**
 * A campaign of this spec's own.
 *
 * Raising a safety hold pauses the WHOLE table and the server gates conflict-prone
 * writes while it is up, so doing that on the shared seed campaign would leak into
 * every spec that runs after this one if anything here failed between raise and
 * release. A private campaign cannot poison anyone.
 */
async function privateFixture(baseURL: string | undefined) {
  const dm: APIRequestContext = await request.newContext({ baseURL, storageState: stateFor('dm') });
  const playerApi: APIRequestContext = await request.newContext({ baseURL, storageState: stateFor('player') });
  const playerUserId: number = (await (await playerApi.get('/api/v1/me')).json()).user.id;

  const campaign = await (
    await dm.post('/api/v1/campaigns', { data: { name: 'E2E — Cockpit campaign chrome' } })
  ).json();
  const campaignId: number = campaign.id;
  // The player must be a member to see the safety bar and receive a check prompt.
  expect(
    (await dm.post(`/api/v1/campaigns/${campaignId}/members`, { data: { userId: playerUserId, role: 'player' } })).ok(),
  ).toBe(true);

  const character = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: {
        name: 'Chrome Probe',
        ownerUserId: String(playerUserId),
        level: 3,
        hpMax: 20,
        hpCurrent: 20,
        stats: { STR: 10, DEX: 14, CON: 12, INT: 10, WIS: 10, CHA: 10 },
        saveProficiencies: ['DEX'],
      },
    })
  ).json();

  const encounter = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: 'Chrome drill', hidden: false },
    })
  ).json();

  return {
    dm,
    campaignId,
    encounterId: encounter.id as number,
    characterId: character.id as number,
    async dispose() {
      await dm.post(`/api/v1/campaigns/${campaignId}/safety/release`, { data: { recovery: 'resume' } }).catch(() => undefined);
      await dm.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
      await dm.dispose();
      await playerApi.dispose();
    },
  };
}

test.describe('encounter cockpit — campaign-wide chrome', () => {
  test.use({ storageState: stateFor('player'), viewport: { width: 1280, height: 800 } });

  test('the safety hold stays visible and clickable, raised or idle', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.getByTestId('safety-banner')).toHaveCount(0);

      const idle = await settledProbe(page, 'safety-bar');
      expect(idle.present).toBe(true);

      // Not merely rendered — a player must be able to actually reach the control.
      await page.getByTestId('safety-bar').getByRole('button').first().click({ trial: true });

      // An active hold is taller than the idle row; the inset has to follow it, or the
      // banner announcing that the table is paused ends up behind the map. Anyone at the
      // table may raise one, so this is the player's own request.
      const raised = await page.request.post(`/api/v1/campaigns/${fixture.campaignId}/safety/hold`, {
        data: { anonymous: true },
      });
      expect(raised.ok(), `raise hold: ${await raised.text()}`).toBe(true);

      await expect(page.getByTestId('safety-banner')).toBeVisible();
      const held = await settledProbe(page, 'safety-bar');
      expect(held.chromeBottom).toBeGreaterThan(idle.chromeBottom);

      // …and the space goes back to the map once the hold is released.
      const released = await fixture.dm.post(`/api/v1/campaigns/${fixture.campaignId}/safety/release`, {
        data: { recovery: 'resume' },
      });
      expect(released.ok(), `release hold: ${await released.text()}`).toBe(true);
      await expect(page.getByTestId('safety-banner')).toHaveCount(0);
      const afterRelease = await settledProbe(page, 'safety-bar');
      expect(afterRelease.chromeBottom).toBeLessThan(held.chromeBottom);
    } finally {
      await fixture.dispose();
    }
  });

  test('arriving from a scrolled page still lands with the chrome on screen', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      // A tall page to scroll, then in-app navigation — which preserves `window.scrollY`,
      // and route focus restores focus with `preventScroll`. Without a reset the cockpit
      // locks the page at that offset with Layout's chrome above the viewport: measured
      // inset 0, safety hold unreachable, and no way to scroll back to it.
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await page.goto(`/c/${fixture.campaignId}`);
      await page.evaluate(() => {
        document.body.style.minHeight = '4000px';
        window.scrollTo(0, 1200);
      });
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

      await page.evaluate(
        ([campaignId, encounterId]) => {
          window.history.pushState({}, '', `/c/${campaignId}/encounters/${encounterId}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        [fixture.campaignId, fixture.encounterId] as const,
      );

      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      const probe = await settledProbe(page, 'safety-bar');
      expect(probe.present).toBe(true);
      // On screen, not merely in the document — a negative `top` is the failure mode.
      expect(probe.chromeBottom).toBeGreaterThan(0);
      await page.getByTestId('safety-bar').getByRole('button').first().click({ trial: true });
    } finally {
      await fixture.dispose();
    }
  });

  test('a delivered check-request prompt is reachable without leaving combat', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      const before = await settledProbe(page, 'safety-bar');

      // The DM requests a check against a character this player owns; the prompt mounts
      // into Layout's chrome while the player is sitting on the cockpit.
      const created = await fixture.dm.post(`/api/v1/campaigns/${fixture.campaignId}/check-requests`, {
        data: {
          characterIds: [fixture.characterId],
          checkId: 'save:DEX',
          dc: 10,
          encounterId: fixture.encounterId,
        },
      });
      expect(created.ok(), `create check request: ${await created.text()}`).toBe(true);

      await expect(page.getByTestId('check-request-prompts')).toBeVisible({ timeout: 15_000 });
      const withPrompt = await settledProbe(page, 'check-request-prompts');
      // The prompt pushed the cockpit further down than the bare safety row did.
      expect(withPrompt.cockpitTop).toBeGreaterThan(before.cockpitTop);
    } finally {
      await fixture.dispose();
    }
  });
});
