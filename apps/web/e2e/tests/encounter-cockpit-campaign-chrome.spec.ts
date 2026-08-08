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
import { expect, test, type Page } from '@playwright/test';
import { restoreSeedEncounter, seed, stateFor } from './seed';

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

test.describe('encounter cockpit — campaign-wide chrome', () => {
  test.use({ storageState: stateFor('player'), viewport: { width: 1280, height: 800 } });

  test('the safety hold stays visible and clickable, raised or idle', async ({ page, browser }) => {
    await restoreSeedEncounter(page);
    const { campaignId, encounterId } = seed();

    // Releasing is DM-only, and the campaign fixture is shared — take a DM context up
    // front so this spec can both clear an inherited hold and clean up its own.
    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const release = () =>
      dmContext.request.post(`/api/v1/campaigns/${campaignId}/safety/release`, {
        data: { recovery: 'resume' },
      });
    await release().catch(() => undefined);

    try {
      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.getByTestId('safety-banner')).toHaveCount(0);

      const idle = await settledProbe(page, 'safety-bar');
      expect(idle.present).toBe(true);

      // Not merely rendered — a player must be able to actually reach the control.
      await page.getByTestId('safety-bar').getByRole('button').first().click({ trial: true });

      // An active hold is taller than the idle row; the inset has to follow it, or the
      // banner announcing that the table is paused ends up behind the map. Anyone at the
      // table may raise one, so this is the player's own request.
      const raised = await page.request.post(`/api/v1/campaigns/${campaignId}/safety/hold`, {
        data: { anonymous: true },
      });
      expect(raised.ok(), `raise hold: ${await raised.text()}`).toBe(true);

      await expect(page.getByTestId('safety-banner')).toBeVisible();
      const held = await settledProbe(page, 'safety-bar');
      expect(held.chromeBottom).toBeGreaterThan(idle.chromeBottom);

      // …and the space goes back to the map once the hold is released.
      const released = await release();
      expect(released.ok(), `release hold: ${await released.text()}`).toBe(true);
      await expect(page.getByTestId('safety-banner')).toHaveCount(0);
      const afterRelease = await settledProbe(page, 'safety-bar');
      expect(afterRelease.cockpitTop).toBeLessThan(held.cockpitTop);
    } finally {
      await release().catch(() => undefined);
      await dmContext.close();
    }
  });

  test('a delivered check-request prompt is reachable without leaving combat', async ({ page, browser }) => {
    await restoreSeedEncounter(page);
    const { campaignId, encounterId, navigation } = seed();

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
    const before = await settledProbe(page, 'safety-bar');

    // The DM requests a check against a character this player owns; the prompt mounts
    // into Layout's chrome while the player is sitting on the cockpit.
    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    let requestCreated = false;
    try {
      // `navigation.characterId` is the seed's player-created sheet (global-setup.ts
      // creates it through a player login, so it is owned by this viewer) — the prompt
      // only reaches a viewer who owns the target character.
      const created = await dmContext.request.post(`/api/v1/campaigns/${campaignId}/check-requests`, {
        data: { characterIds: [navigation.characterId], checkId: 'save:DEX', dc: 10, encounterId },
      });
      expect(created.ok(), `create check request: ${await created.text()}`).toBe(true);
      requestCreated = true;

      const prompts = page.getByTestId('check-request-prompts');
      await expect(prompts).toBeVisible({ timeout: 15_000 });
      const withPrompt = await settledProbe(page, 'check-request-prompts');
      // The prompt pushed the cockpit further down than the bare safety row did.
      expect(withPrompt.cockpitTop).toBeGreaterThan(before.cockpitTop);
    } finally {
      if (requestCreated) {
        const pending = await dmContext.request.get(
          `/api/v1/campaigns/${campaignId}/check-requests?status=pending`,
        );
        if (pending.ok()) {
          for (const request of (await pending.json()) as Array<{ id: number }>) {
            await dmContext.request.delete(`/api/v1/check-requests/${request.id}`).catch(() => undefined);
          }
        }
      }
      await dmContext.close();
    }
  });
});
