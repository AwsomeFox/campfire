/**
 * Campaign-wide interrupts stay reachable over the encounter cockpit.
 *
 * `Layout.tsx` mounts a player's check-request prompts (#415) and its status banners
 * outside the routed page, so they reach every campaign route. The cockpit is
 * `position: fixed; inset: 0` with an opaque background, so it painted straight over
 * them: a delivered prompt could not be clicked while combat was on screen.
 * `useImmersiveChromeInset` publishes how far down that chrome reaches and the shell
 * insets its own top by it.
 *
 * These assertions are deliberately about HIT-TESTING, not visibility. The bug did not
 * hide the elements — `toBeVisible()` passed the whole time, because they were rendered
 * at their normal size underneath an opaque overlay. Only `elementFromPoint` (and an
 * actual click) tells the two states apart.
 *
 * WHAT CHANGED, AND WHY THE SAFETY HOLD IS NO LONGER THE SUBJECT HERE
 *
 * The participant safety hold (#599) was this file's original motivating case, and the
 * probes below used to target it. It is now scoped to the AI Table route (Layout's
 * `onPlaySurface`) and does not mount on the cockpit at all, so "the hold sits above the
 * cockpit and stays clickable" is not a property this route has any more — asserting it
 * would be asserting the layout the redesign deliberately removed.
 *
 * That is a genuine reduction in coverage of #599 on THIS surface, so it is replaced
 * rather than deleted, in two parts:
 *   - here, the same inset/hit-testing invariants are re-anchored onto the chrome that
 *     does still mount over the cockpit (check-request prompts, Layout's banners), which
 *     is what the hook actually exists to protect;
 *   - and `the safety hold is absent from the cockpit and present on the table` below
 *     pins the new scope itself, so a future edit cannot quietly restore the strip or
 *     drop the control from the route that is supposed to keep it.
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

/** Where the cockpit starts, with no particular chrome element to anchor on. */
async function cockpitTopPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const shell = document.querySelector('.cf-vtt');
    return shell instanceof HTMLElement ? Math.round(shell.getBoundingClientRect().top) : -1;
  });
}

/**
 * Ask for a check against the player's character — the one piece of Layout chrome that
 * still mounts over the cockpit on demand, and therefore the anchor for the inset
 * assertions that used to ride on the safety hold.
 *
 * Separate from the on-screen wait because the archived-campaign tests below must call
 * this BEFORE they archive: creating a check request is a domain write, and Campfire
 * refuses writes to an archived campaign. Archive first and this 4xxs.
 */
async function createCheckRequest(fixture: {
  dm: APIRequestContext;
  campaignId: number;
  encounterId: number;
  characterId: number;
}) {
  const created = await fixture.dm.post(`/api/v1/campaigns/${fixture.campaignId}/check-requests`, {
    data: {
      characterIds: [fixture.characterId],
      checkId: 'save:DEX',
      dc: 10,
      encounterId: fixture.encounterId,
    },
  });
  expect(created.ok(), `create check request: ${await created.text()}`).toBe(true);
}

async function expectPromptOnScreen(page: Page) {
  await expect(page.getByTestId('check-request-prompts')).toBeVisible({ timeout: 15_000 });
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

  test('tall campaign chrome is honoured, not clipped at half the viewport', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      // Archived banner plus a delivered check prompt, on a short viewport: together they
      // can reach past half the screen, which is where the old share-of-viewport clamp
      // stopped ceding and the opaque, scroll-locked cockpit began covering the lower one.
      // (The second source used to be a raised safety hold. It no longer paints on this
      // route, so raising one here would have quietly reduced this to a one-banner test.)
      await page.setViewportSize({ width: 320, height: 560 });
      // NOTE: this viewport does not trip the ceiling — see the 300x280 test below, which
      // does. This one guards the ordinary case: chrome above, cockpit below, both usable.
      await createCheckRequest(fixture);
      const archived = await fixture.dm.patch(`/api/v1/campaigns/${fixture.campaignId}`, {
        data: { status: 'paused' },
      });
      expect(archived.ok(), `archive campaign: ${await archived.text()}`).toBe(true);

      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expectPromptOnScreen(page);

      // Every bit of Layout chrome above the cockpit must still be on screen: the cockpit
      // starts at or below the lowest of it, and keeps a usable height for itself.
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const main = document.getElementById('main-content');
              const shell = document.querySelector('.cf-vtt');
              if (!(main instanceof HTMLElement) || !(shell instanceof HTMLElement)) return null;
              const shellTop = shell.getBoundingClientRect().top;
              let lowest = 0;
              for (let el = main.previousElementSibling; el; el = el.previousElementSibling) {
                if (!(el instanceof HTMLElement)) continue;
                const r = el.getBoundingClientRect();
                if (r.height > 0) lowest = Math.max(lowest, r.bottom);
              }
              return Math.round(shellTop - lowest);
            }),
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(0);

      const shellHeight = await page.evaluate(
        () => Math.round(document.querySelector('.cf-vtt')?.getBoundingClientRect().height ?? 0),
      );
      expect(shellHeight, 'the cockpit keeps a usable height of its own').toBeGreaterThanOrEqual(200);
    } finally {
      await fixture.dm
        .patch(`/api/v1/campaigns/${fixture.campaignId}`, { data: { status: 'active' } })
        .catch(() => undefined);
      await fixture.dispose();
    }
  });

  test('chrome that outgrows the cockpit scrolls instead of being covered', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      // Small enough that Layout's own header and banners fill the entire budget on their
      // own. Past that line, locking the page and covering the overflow would strand chrome
      // nobody can reach — a pending check request with no way to scroll to it — so the
      // cockpit gives up the viewport instead.
      await page.setViewportSize({ width: 300, height: 280 });
      // The tall chrome is a delivered check prompt. It used to be a raised safety hold,
      // which no longer mounts here at all — without something in its place the archived
      // banner alone may not clear the ceiling, and the test would pass by never reaching
      // the state it exists to describe. Requested BEFORE the archive, which blocks writes.
      await createCheckRequest(fixture);
      const archived = await fixture.dm.patch(`/api/v1/campaigns/${fixture.campaignId}`, {
        data: { status: 'paused' },
      });
      expect(archived.ok(), `archive campaign: ${await archived.text()}`).toBe(true);

      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expectPromptOnScreen(page);

      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const main = document.getElementById('main-content');
              const shell = document.querySelector('.cf-vtt');
              if (!(main instanceof HTMLElement) || !(shell instanceof HTMLElement)) return null;
              let lowest = 0;
              for (let el = main.previousElementSibling; el; el = el.previousElementSibling) {
                if (!(el instanceof HTMLElement)) continue;
                const r = el.getBoundingClientRect();
                if (r.height > 0) lowest = Math.max(lowest, r.bottom);
              }
              return {
                clearance: Math.round(shell.getBoundingClientRect().top - lowest),
                scrollable: document.documentElement.scrollHeight > window.innerHeight,
                height: Math.round(shell.getBoundingClientRect().height),
              };
            }),
          { timeout: 10_000 },
        )
        .toMatchObject({ scrollable: true });

      const state = await page.evaluate(() => {
        const main = document.getElementById('main-content');
        const shell = document.querySelector('.cf-vtt') as HTMLElement | null;
        if (!(main instanceof HTMLElement) || !shell) return null;
        let lowest = 0;
        for (let el = main.previousElementSibling; el; el = el.previousElementSibling) {
          if (!(el instanceof HTMLElement)) continue;
          const r = el.getBoundingClientRect();
          if (r.height > 0) lowest = Math.max(lowest, r.bottom);
        }
        return {
          clearance: Math.round(shell.getBoundingClientRect().top - lowest),
          height: Math.round(shell.getBoundingClientRect().height),
        };
      });
      expect(state, 'cockpit and chrome must both exist').not.toBeNull();
      // Nothing of Layout's chrome is underneath the cockpit...
      expect(state!.clearance).toBeGreaterThanOrEqual(0);
      // ...and the surface itself is still worth showing.
      expect(state!.height).toBeGreaterThanOrEqual(300);

      // The scroll caps come off with the lock. They exist only because the page cannot
      // scroll, and the cap they read is zero here by definition — that is what tripped
      // the hatch — so leaving them on collapses the prompts to their own padding.
      const prompts = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="check-request-prompts"]') as HTMLElement | null;
        if (!el) return null;
        return { height: Math.round(el.getBoundingClientRect().height), maxHeight: getComputedStyle(el).maxHeight };
      });
      expect(prompts, 'the check-request prompts must be present').not.toBeNull();
      expect(prompts!.maxHeight).toBe('none');
      expect(prompts!.height, 'the prompts keep their content, not just their padding').toBeGreaterThan(24);

      // The hatch must survive a re-measure. (The related hazard — a viewer scrolling down
      // to the cockpit making the chrome measure as shrunk, dropping the hatch and
      // re-locking the page under them — is handled by measuring document-relative in the
      // hook. I could not stage it here: `window.scrollTo` does not take in this state,
      // so this asserts only that a resize does not spuriously drop the hatch.)
      await page.setViewportSize({ width: 301, height: 280 });
      await expect
        .poll(async () =>
          page.evaluate(() => document.documentElement.classList.contains('cf-vtt-chrome-overflow')),
        )
        .toBe(true);
    } finally {
      await fixture.dm
        .patch(`/api/v1/campaigns/${fixture.campaignId}`, { data: { status: 'active' } })
        .catch(() => undefined);
      await fixture.dispose();
    }
  });

  test('the inset follows chrome that grows after the first paint', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      // Archiving mounts Layout's read-only banner ABOVE `<main>`, and its provenance line
      // (`ArchivedProvenance`) comes from a SEPARATE request. Narrow enough that the extra
      // text wraps to another line — which moves `<main>` down without either named chrome
      // element changing size, so nothing the hook watched by name reported it.
      await page.setViewportSize({ width: 360, height: 800 });
      const archived = await fixture.dm.patch(`/api/v1/campaigns/${fixture.campaignId}`, {
        data: { status: 'paused' },
      });
      expect(archived.ok(), `archive campaign: ${await archived.text()}`).toBe(true);

      // Hold that request so the growth lands strictly AFTER the first measurement.
      // Unheld it resolves first and the inset is correct by luck, which is exactly the
      // race this test has to remove.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/status-transitions*', async (route) => {
        await held;
        await route.continue();
      });

      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();

      const banner = page.getByRole('status').filter({ hasText: /paused/i }).first();
      await expect(banner).toBeVisible();
      const before = await banner.evaluate((el) => Math.round(el.getBoundingClientRect().height));

      release();
      await expect(banner).toContainText(/Archived by/i, { timeout: 10_000 });
      // If it does not actually wrap at this width the test proves nothing — say so.
      await expect
        .poll(async () => banner.evaluate((el) => Math.round(el.getBoundingClientRect().height)), {
          timeout: 5_000,
        })
        .toBeGreaterThan(before);

      // The cockpit must end up below the banner's FINAL height, not the height it had
      // when the inset was first published.
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const b = document.querySelector('[role="status"]');
              const shell = document.querySelector('.cf-vtt');
              if (!(b instanceof HTMLElement) || !(shell instanceof HTMLElement)) return null;
              return Math.round(shell.getBoundingClientRect().top - b.getBoundingClientRect().bottom);
            }),
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(0);
      await page.unroute('**/status-transitions*');
    } finally {
      await fixture.dm
        .patch(`/api/v1/campaigns/${fixture.campaignId}`, { data: { status: 'active' } })
        .catch(() => undefined);
      await fixture.dispose();
    }
  });

  /**
   * The scope itself, in both directions (issue #599 as it now stands).
   *
   * The hold used to ride above the cockpit as its own strip, and this file used to assert
   * that. It was removed from here because the cockpit is the densest surface in the app
   * and a permanent red band is a row off the board — but "removed from the cockpit" is
   * only correct if the control still exists somewhere a participant can get to. So this
   * asserts BOTH halves: gone from the encounter, and still there, still clickable, on the
   * Table page. Half of this passing on its own is a bug either way round.
   */
  test('the safety hold is absent from the cockpit and present on the table', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.getByTestId('safety-bar')).toHaveCount(0);

      // Idle, on the route that keeps it: present AND reachable, not merely rendered.
      // Anyone at the table may press it, so this is the PLAYER's own click — see the
      // `storageState` on `test.use` above — not the DM's.
      await page.goto(`/c/${fixture.campaignId}/table`);
      await expect(page.getByTestId('safety-hold-btn')).toBeVisible();
      await page.getByTestId('safety-hold-btn').click({ trial: true });

      // Not just while idle: an ACTIVE hold must not reintroduce a band on the cockpit
      // either. The gated lifecycle controls carry the reason there instead of a strip.
      const raised = await page.request.post(`/api/v1/campaigns/${fixture.campaignId}/safety/hold`, {
        data: { anonymous: true },
      });
      expect(raised.ok(), `raise hold: ${await raised.text()}`).toBe(true);

      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.getByTestId('safety-bar')).toHaveCount(0);
      await expect(page.getByTestId('safety-banner')).toHaveCount(0);

      // …while the Table page shows the raised state in full. Loaded fresh rather than
      // waiting on the hold poll, so this asserts the scope and not a refetch interval.
      await page.goto(`/c/${fixture.campaignId}/table`);
      await expect(page.getByTestId('safety-banner')).toBeVisible();
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
      // inset 0, the chrome unreachable, and no way to scroll back to it.
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await createCheckRequest(fixture);
      await expectPromptOnScreen(page);
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
      const probe = await settledProbe(page, 'check-request-prompts');
      expect(probe.present).toBe(true);
      // On screen, not merely in the document — a negative `top` is the failure mode.
      expect(probe.chromeBottom).toBeGreaterThan(0);
      await page.getByTestId('check-request-prompts').getByRole('button').first().click({ trial: true });
    } finally {
      await fixture.dispose();
    }
  });

  test('a delivered check-request prompt is reachable without leaving combat', async ({ page, baseURL }) => {
    const fixture = await privateFixture(baseURL || undefined);
    try {
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      // Baseline with no interrupt on screen. This used to be a probe of the safety row,
      // which is no longer on this route — so the cockpit's own top is the baseline, and
      // the prompt has to push it down from there.
      const before = await cockpitTopPx(page);
      expect(before, 'the cockpit must be mounted').toBeGreaterThanOrEqual(0);

      // The DM requests a check against a character this player owns; the prompt mounts
      // into Layout's chrome while the player is sitting on the cockpit.
      await createCheckRequest(fixture);
      await expectPromptOnScreen(page);
      const withPrompt = await settledProbe(page, 'check-request-prompts');
      expect(withPrompt.cockpitTop).toBeGreaterThan(before);

      // Reachable, not merely uncovered — the original bug left it clickable-looking and
      // dead under an opaque overlay, which only a real hit test catches.
      await page.getByTestId('check-request-prompts').getByRole('button').first().click({ trial: true });
    } finally {
      await fixture.dispose();
    }
  });
});
