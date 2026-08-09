import { test, expect, type Page } from '@playwright/test';
import { MONSTERS } from '../global-setup';
import { seed, stateFor, restoreSeedEncounter } from './seed';
import { cockpitPanel, openCockpitTab } from '../lib/encounterCockpit';

/**
 * Combat tracker cross-role checks (issue #81):
 *  - DM: exact turn/initiative + HP math renders, and the DM-only run controls
 *    (Start/Roll initiative/Next turn/End/player-display actions) are present.
 *  - player & viewer: a monster's exact HP is redacted to a coarse band, and the
 *    DM-only controls + per-combatant edit controls are absent (the silent
 *    permission-drift the audit called out).
 */

const [boss, skirmisher] = MONSTERS;

function encounterUrl(): string {
  const { campaignId, encounterId } = seed();
  return `/c/${campaignId}/encounters/${encounterId}`;
}

function endedEncounterUrl(): string {
  const { campaignId, endedEncounterId } = seed();
  return `/c/${campaignId}/encounters/${endedEncounterId}`;
}

async function openEncounter(page: Page) {
  await restoreSeedEncounter(page);
  await page.goto(encounterUrl());
  await expect(page.getByRole('heading', { name: 'Ambush at the Ember Hearth' })).toBeVisible();
}

test.describe('combat tracker — DM view', () => {
  test.use({ storageState: stateFor('dm') });

  test('renders exact initiative, HP math, running state and DM controls', async ({ page }) => {
    await openEncounter(page);

    // Fight is running (seeded via /start) — status + round render.
    await expect(page.getByText('Running', { exact: false }).first()).toBeVisible();
    // The current-turn workspace (issue #413) also shows "Round N", so scope to the first.
    await expect(page.getByText(/Round\s*1/).first()).toBeVisible();

    // Both monsters present with exact HP "current / max" (issue #81 HP math).
    // The ended-encounter summary in the Turn panel lists the same names, so scope to
              // the roster rather than taking whichever copy comes first in the DOM.
    await expect(cockpitPanel(page, 'party').getByText(boss.name).first()).toBeVisible();
    await expect(page.getByText(`${boss.hpMax} / ${boss.hpMax}`).first()).toBeVisible();
    await expect(page.getByText(`${skirmisher.hpMax} / ${skirmisher.hpMax}`).first()).toBeVisible();

    // Exact initiative is editable by the DM (aria-labelled number inputs).
    await expect(page.getByLabel(`Initiative for ${boss.name}`)).toHaveValue(String(boss.initiative));
    await expect(page.getByLabel(`Initiative for ${skirmisher.name}`)).toHaveValue(String(skirmisher.initiative));

    // DM-only run controls exist. Scope to the header Next turn button because the
    // workspace also exposes an end-of-turn Next turn button (issue #1456).
    await expect(page.getByTestId('encounter-header-next-turn')).toBeVisible();
    await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible();

    // On the RUNNING encounter the DM's per-combatant HP controls are present — this is the
    // interactive marker the ended-encounter test below asserts is gone (issue #368).
    await expect(page.getByRole('button', { name: new RegExp(`(Reduce|Increase) ${boss.name}'s HP`) }).first()).toBeVisible();

    // Player-display (Cast) is table-wide setup, so the cockpit keeps it in the Table tab
    // rather than in the header beside the turn controls.
    await openCockpitTab(page, 'table');
    await expect(page.getByRole('button', { name: 'Open display', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect/focus', exact: true })).toBeVisible();
  });

  test('keeps keyboard-opened display lifecycle and encounter updates in the DM cockpit (#762)', async ({ page }) => {
    await openEncounter(page);
    await openCockpitTab(page, 'table');
    const { campaignId } = seed();
    const openDisplay = page.getByRole('button', { name: 'Open display', exact: true });
    const popupPromise = page.waitForEvent('popup');
    await openDisplay.focus();
    await page.keyboard.press('Enter');
    const popup = await popupPromise;

    await expect(page).toHaveURL(encounterUrl());
    await expect(popup).toHaveURL(/\/cast\/\d+\/cf_cast_/);
    const status = page.getByTestId('player-display-status');
    await expect(status).toContainText(/Display connected/i);
    await popup.close();
    await expect(status).toContainText(/Display window was closed/i);

    // A display can follow a different encounter after its own authoritative
    // refresh. Exercise the same-origin status protocol rather than leaking a
    // capability URL through test messaging.
    await page.evaluate((id) => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'ready', campaignId: id, encounterId: 999, encounterName: 'Second encounter' },
      }));
    }, campaignId);
    await expect(status).toContainText(/following another encounter \(Second encounter\)/i);
  });

  test('keeps player-display controls usable at a tablet viewport (#762)', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      hasTouch: true,
      isMobile: true,
      viewport: { width: 768, height: 1024 },
    });
    const page = await context.newPage();
    await openEncounter(page);
    await openCockpitTab(page, 'table');
    for (const name of ['Open display', 'Copy link', 'Reconnect/focus']) {
      const control = page.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      // Assert REACHABILITY, not scroll position (issue #1994).
      //
      // What goes wrong without this: the encounter document is 4-6x the viewport tall at
      // this size, these controls sit near its top, and the page auto-scrolls shortly after
      // load — measured, `window.scrollY` settles around 1786, putting all three roughly
      // 1600px above the fold. `toBeVisible` still passes (they are rendered); a viewport
      // check reports ratio 0 and keeps reporting it, because once scrolled that state is
      // stable. So the assertion was really testing whether it had won a race against the
      // auto-scroll, which is why it failed intermittently rather than consistently.
      //
      // Why the scroll is INSIDE the poll: the auto-scroll fires at an unpredictable moment,
      // so scrolling once before a retrying assertion just moves the same race later — the
      // retry re-measures but never re-scrolls. Each attempt re-establishes position.
      //
      // Why full containment rather than a viewport ratio: `toBeInViewport` passes on any
      // non-zero overlap, so a partially clipped control satisfied it. `left >= 0 &&
      // right <= innerWidth` is what preserves #762's actual guarantee — these controls were
      // unusable at tablet width — and scrolling cannot paper over it, because this layout
      // does not scroll horizontally.
      await expect
        .poll(async () => {
          await control.scrollIntoViewIfNeeded();
          return control.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
          });
        })
        .toBe(true);
    }
    await expect(page.getByTestId('player-display-status')).toBeVisible();
    await expect(page).toHaveURL(encounterUrl());
    await context.close();
  });

  test('DM can clear initiative back to the unrolled state via the Clear control (issue #715)', async ({ page }) => {
    await openEncounter(page);
    const initInput = page.getByLabel(`Initiative for ${boss.name}`);

    // The boss starts with a rolled initiative and a Clear ("×") control beside it.
    await expect(initInput).toHaveValue(String(boss.initiative));
    const clearBtn = page.getByLabel(`Clear ${boss.name} roll order`);
    await expect(clearBtn).toBeVisible();

    // Clear it — PATCH { initiative: null } lands, the server writes NULL, and the input
    // empties (placeholder '–'). The Clear button disappears because there's nothing to clear.
    await clearBtn.click();
    await expect(initInput).toHaveValue('');
    await expect(clearBtn).toHaveCount(0);

    // Keyboard path: typing a value then Backspace-on-empty also clears (issue #715).
    await initInput.fill('14');
    await initInput.press('Enter');
    await expect(initInput).toHaveValue('14');
    await expect(page.getByLabel(`Clear ${boss.name} roll order`)).toBeVisible();
    await initInput.focus();
    await initInput.fill('');
    await initInput.press('Backspace');
    await expect(initInput).toHaveValue('');
    await expect(page.getByLabel(`Clear ${boss.name} roll order`)).toHaveCount(0);

    // Restore for any later tests that assume a rolled initiative.
    await initInput.fill(String(boss.initiative));
    await initInput.press('Enter');
    await expect(initInput).toHaveValue(String(boss.initiative));
  });

  test('an ENDED encounter renders read-only: combatant visible but no interactive controls (#368)', async ({ page }) => {
    await page.goto(endedEncounterUrl());
    await expect(page.getByRole('heading', { name: 'Aftermath at the Ember Hearth' })).toBeVisible();
    await openCockpitTab(page, 'party');

    // The encounter is over — the combatant still shows (read-only), but none of the
    // per-combatant mutation controls that fire a PATCH the server rejects (assertMutable)
    // are rendered: no HP +/- buttons and no editable initiative input.
    await expect(cockpitPanel(page, 'party').getByText(boss.name).first()).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`(Reduce|Increase) ${boss.name}'s HP`) })).toHaveCount(0);
    await expect(page.getByLabel(`Initiative for ${boss.name}`)).toHaveCount(0);

    // Encounter-level map/grid/fog controls are also hidden (#470).
    await expect(page.getByRole('button', { name: /upload|replace|remove map/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /reveal/i })).toHaveCount(0);
  });
});

test.describe('combat tracker — non-DM views', () => {
  for (const role of ['player', 'viewer'] as const) {
    test.describe(role, () => {
      test.use({ storageState: stateFor(role) });

      test('monster HP is redacted to a band and no DM controls show', async ({ page }) => {
        await openEncounter(page);
        // A player lands on the Turn tab while combat runs; the roster is Party.
        await openCockpitTab(page, 'party');

        // The monster is visible in the order...
        await expect(cockpitPanel(page, 'party').getByText(boss.name).first()).toBeVisible();
        // ...but its exact HP number is NOT — the client shows a coarse band label.
        await expect(page.getByText(`${boss.hpMax} / ${boss.hpMax}`)).toHaveCount(0);
        await expect(page.getByText('Healthy').first()).toBeVisible();

        // Initiative is read-only (span, not an input) for non-DM.
        await expect(page.getByLabel(`Initiative for ${boss.name}`)).toHaveCount(0);

        // None of the DM-only run controls render.
        await expect(page.getByTestId('encounter-header-next-turn')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'End', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Cast', exact: true })).toHaveCount(0);
      });
    });
  }
});

/**
 * Matches ONLY the map-bytes endpoint (`GET .../map` or `.../map?revision=...`),
 * never `.../map/derivatives` (issue #1996). The battle map fires both requests
 * on mount — `useDerivativeManifest` polls the responsive-ladder manifest at
 * `.../map/derivatives` alongside the `<img>` request for `.../map` itself — and
 * a substring match like `url().includes('.../map')` matches both, since
 * `.../map/derivatives` also contains `.../map` as a prefix. Whichever of the two
 * responses lands first then wins `waitForResponse`, so the assertion can silently
 * read headers off the JSON manifest (no explicit `Cache-Control`, so `undefined`)
 * instead of the image response (always `private, no-store, max-age=0`) — a
 * harness-side race, not a missing server header. Anchoring on `map` followed by
 * `?` or end-of-string excludes the `/derivatives` child route.
 */
function isMapBytesUrl(url: string, encounterId: number): boolean {
  return new RegExp(`/api/v1/encounters/${encounterId}/map(?:\\?|$)`).test(url);
}

test.describe('combat tracker — fog-safe map delivery (#463)', () => {
  test.use({ storageState: stateFor('player') });

  test('player canvas uses the encounter map endpoint and the raw attachment stays inaccessible', async ({ page }) => {
    const { encounterId, mapAttachmentId } = seed();

    // Regression for issue #1996: `useDerivativeManifest` polls `.../map/derivatives`
    // concurrently with the `<img>` request for `.../map`, and the small JSON manifest
    // normally resolves first. Delaying the map-bytes response makes that ordering
    // deterministic (rather than a timing-dependent flake), so this test reliably
    // proves the predicate below reads the map-bytes response even when the manifest
    // wins the race.
    // A RegExp route matcher (not a glob) so `?` is a literal query-string anchor
    // rather than a single-character wildcard that would also swallow `/derivatives`.
    await page.route(new RegExp(`/api/v1/encounters/${encounterId}/map\\?`), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.continue();
    });

    const mapResponse = page.waitForResponse((response) => isMapBytesUrl(response.url(), encounterId));
    await openEncounter(page);

    const map = page.getByRole('img', { name: 'Battle map' });
    await expect(map).toBeVisible();
    await expect(map).toHaveAttribute('src', new RegExp(`/api/v1/encounters/${encounterId}/map\\?revision=`));
    await expect(map).not.toHaveAttribute('src', new RegExp(`/attachments/${mapAttachmentId}/file`));

    const response = await mapResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['x-campfire-map-view']).toBe('fog-protected');

    const raw = await page.request.get(`/api/v1/attachments/${mapAttachmentId}/file`);
    expect(raw.status()).toBe(404);
    const rawThumb = await page.request.get(`/api/v1/attachments/${mapAttachmentId}/file?size=thumb`, {
      headers: { Range: 'bytes=0-31' },
    });
    expect(rawThumb.status()).toBe(404);

    // Once the production service worker controls the page, a reload must still
    // fetch the role-safe view from the network and must not leave either source
    // or rendered map bytes in Campfire's shared CacheStorage (#463 stale-cache case).
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
    });
    const reloadedMap = page.waitForResponse((res) => isMapBytesUrl(res.url(), encounterId));
    await page.reload();
    expect((await reloadedMap).status()).toBe(200);
    const cachedUrls = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        urls.push(...(await cache.keys()).map((request) => request.url));
      }
      return urls;
    });
    expect(cachedUrls.some((url) => url.includes(`/api/v1/encounters/${encounterId}/map`))).toBe(false);
    expect(cachedUrls.some((url) => url.includes(`/api/v1/attachments/${mapAttachmentId}/file`))).toBe(false);
  });
});
