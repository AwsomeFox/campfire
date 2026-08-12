/**
 * Live stacking proof for the cockpit's short-viewport escape hatch (issue #2163 review,
 * third Codex P2).
 *
 * `html.cf-vtt-chrome-overflow .cf-vtt` used to set `position: static` to return the
 * cockpit to normal document flow once Layout's own chrome needs more room than the
 * cockpit can cede (see the CSS comment above that rule, and
 * `encounter-cockpit-campaign-chrome.spec.ts`'s "chrome that outgrows the cockpit scrolls
 * instead of being covered" test, which this fixture mirrors to trip the same hatch).
 *
 * `z-index` only takes effect on a POSITIONED element (or a flex/grid item) — on
 * `position: static` it is inert outright, not merely weakened, so `.cf-vtt` was silently
 * NOT a stacking context in this mode (it is a normal, non-grid-item child of `<main>`
 * here). Every raw z-index this audit's other specs classify as "local, contained inside
 * .cf-vtt" — the death-save spectator toast in particular, which independently keeps
 * `position: fixed` regardless of `.cf-vtt`'s own position — would bubble up in this one
 * mode and compete directly with Layout chrome (the tab bar in particular, tied at the
 * literal `40`) instead of being safely contained, decided by DOM order rather than the
 * documented scale. That is the exact bug class P2 #1 found in `.cf-gated-hint`, just
 * reachable through a different, narrower door (a rare short-viewport mode) instead of an
 * always-present render site.
 *
 * The fix (index.css) swaps `position: static` for `position: relative` with no offset —
 * identical box, identical document-flow contribution, identical "takes its height in
 * flow, below whatever is above it" behavior the surrounding CSS comment describes — while
 * restoring the stacking context `z-index` needs to mean anything at all. This spec proves
 * that live: trip the hatch for real (not by asserting the class exists, but by measuring
 * .cf-vtt's own computed position/z-index once it does), then run the exact same real-toast
 * injection + elementFromPoint proof z-index-audit-toast-stacking.spec.ts already uses for
 * the ordinary (non-overflow) case, to confirm the SAME containment holds here too.
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { stateFor } from './seed';

/**
 * A private campaign, mirroring encounter-cockpit-campaign-chrome.spec.ts's own
 * `privateFixture` (not exported from that file) — raising a safety hold / pausing a
 * campaign on the shared seed campaign would leak into every spec that runs after this one.
 */
async function overflowFixture(baseURL: string | undefined) {
  const dm: APIRequestContext = await request.newContext({ baseURL, storageState: stateFor('dm') });
  const playerApi: APIRequestContext = await request.newContext({ baseURL, storageState: stateFor('player') });
  const playerUserId: number = (await (await playerApi.get('/api/v1/me')).json()).user.id;

  const campaign = await (
    await dm.post('/api/v1/campaigns', { data: { name: 'E2E — 2163 overflow-mode stacking' } })
  ).json();
  const campaignId: number = campaign.id;
  expect(
    (await dm.post(`/api/v1/campaigns/${campaignId}/members`, { data: { userId: playerUserId, role: 'player' } })).ok(),
  ).toBe(true);

  const character = await (
    await dm.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: {
        name: 'Overflow Probe',
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
      data: { name: 'Overflow drill', hidden: false },
    })
  ).json();

  return {
    dm,
    campaignId,
    encounterId: encounter.id as number,
    characterId: character.id as number,
    async dispose() {
      await dm.patch(`/api/v1/campaigns/${campaignId}`, { data: { status: 'active' } }).catch(() => undefined);
      await dm.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
      await dm.dispose();
      await playerApi.dispose();
    },
  };
}

/** Trips the escape hatch the same way encounter-cockpit-campaign-chrome.spec.ts does: a
 * short viewport plus tall campaign-wide chrome (a delivered check-request prompt) the
 * cockpit cannot cede room for. */
async function tripOverflowHatch(
  page: Page,
  fixture: Awaited<ReturnType<typeof overflowFixture>>,
): Promise<void> {
  await page.setViewportSize({ width: 300, height: 280 });
  const created = await fixture.dm.post(`/api/v1/campaigns/${fixture.campaignId}/check-requests`, {
    data: { characterIds: [fixture.characterId], checkId: 'save:DEX', dc: 10, encounterId: fixture.encounterId },
  });
  expect(created.ok(), `create check request: ${await created.text()}`).toBe(true);
  const archived = await fixture.dm.patch(`/api/v1/campaigns/${fixture.campaignId}`, { data: { status: 'paused' } });
  expect(archived.ok(), `archive campaign: ${await archived.text()}`).toBe(true);

  await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.encounterId}`);
  await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
  await expect(page.getByTestId('check-request-prompts')).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => page.evaluate(() => document.documentElement.classList.contains('cf-vtt-chrome-overflow')), {
      timeout: 10_000,
    })
    .toBe(true);
}

test.describe('z-index audit — cockpit stacking context survives the overflow escape hatch (issue #2163 review)', () => {
  test.use({ storageState: stateFor('player') });

  test('.cf-vtt keeps its stacking context, and a real toast still outranks the tab bar, once the hatch trips', async ({
    page,
    baseURL,
  }) => {
    const fixture = await overflowFixture(baseURL || undefined);
    try {
      await tripOverflowHatch(page, fixture);

      // The mechanism itself, measured directly: .cf-vtt must be POSITIONED (not static) with
      // a non-auto z-index once the hatch is up, or none of the rest of this test — or the
      // "local, contained" classification the other z-index-audit specs rely on — means
      // anything in this mode.
      const mechanism = await page.evaluate(() => {
        const vtt = document.querySelector('.cf-vtt');
        if (!(vtt instanceof HTMLElement)) return { ok: false as const, reason: 'missing .cf-vtt' };
        const cs = getComputedStyle(vtt);
        return {
          ok: true as const,
          overflowClassActive: document.documentElement.classList.contains('cf-vtt-chrome-overflow'),
          position: cs.position,
          zIndex: cs.zIndex,
        };
      });
      expect(mechanism.ok, mechanism.ok ? undefined : mechanism.reason).toBe(true);
      if (!mechanism.ok) return;
      expect(mechanism.overflowClassActive, 'the hatch must actually be tripped for this test to mean anything').toBe(true);
      expect(mechanism.position, '.cf-vtt must not be position:static in overflow mode — z-index is inert on static').not.toBe('static');
      expect(mechanism.zIndex).toBe('41');

      // The decisive proof: the same real-toast-injection + elementFromPoint technique
      // z-index-audit-toast-stacking.spec.ts uses for the ordinary (non-overflow) case,
      // run here with the hatch active. If .cf-vtt's containment had actually collapsed,
      // the toast's local z-index:40 would tie .cf-tabbar's 40 and lose the DOM-order
      // tiebreak (the tab bar renders later than <main>), so this is a real discriminating
      // test, not a tautology.
      const tabbar = page.locator('.cf-tabbar');
      await expect(tabbar).toBeVisible();

      const result = await page.evaluate(() => {
        const describe = (el: Element | null) => ({
          inVtt: Boolean(el?.closest('.cf-vtt')),
          inTabbar: Boolean(el?.closest('.cf-tabbar')),
          tag: el?.tagName ?? null,
          className: el instanceof HTMLElement ? el.className : null,
        });

        const vtt = document.querySelector('.cf-vtt') as HTMLElement | null;
        const tabbarEl = document.querySelector('.cf-tabbar') as HTMLElement | null;
        if (!vtt || !tabbarEl) return { ok: false as const, reason: 'missing .cf-vtt or .cf-tabbar' };

        const tabRect = tabbarEl.getBoundingClientRect();
        const point = {
          x: Math.round(tabRect.left + tabRect.width / 2),
          y: Math.round(tabRect.top + tabRect.height / 2),
        };

        const beforeHit = describe(document.elementFromPoint(point.x, point.y));

        const toast = document.createElement('div');
        toast.className = 'cf-death-save-spectator-toast';
        toast.setAttribute('data-testid', 'zaudit-2163-overflow-injected-toast');
        toast.style.position = 'fixed';
        toast.style.left = `${tabRect.left}px`;
        toast.style.top = `${tabRect.top}px`;
        toast.style.width = `${tabRect.width}px`;
        toast.style.height = `${tabRect.height}px`;
        // Same neutralization as z-index-audit-toast-stacking.spec.ts: the real rule also
        // sets `transform: translateX(-50%)` and a mount animation driving
        // `transform`/`opacity`, both of which fight the exact rect above and neither of
        // which affects z-index/stacking (the only thing under test).
        toast.style.transform = 'none';
        toast.style.animation = 'none';
        vtt.appendChild(toast);
        const toastZIndex = getComputedStyle(toast).zIndex;

        const withRealZIndexHit = document.elementFromPoint(point.x, point.y);
        const wonWithRealZIndex = withRealZIndexHit === toast;

        toast.remove();
        const afterHit = describe(document.elementFromPoint(point.x, point.y));

        return {
          ok: true as const,
          beforeHit,
          toastZIndex,
          wonWithRealZIndex,
          afterHit,
          tabbarZIndex: getComputedStyle(tabbarEl).zIndex,
        };
      });

      expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
      if (!result.ok) return;

      expect(result.tabbarZIndex).toBe('40');
      expect(result.toastZIndex).toBe('40');
      // .cf-vtt already wins at the tab bar's own point with no injection at all — same
      // core claim as the non-overflow case, now proven to still hold with the hatch up.
      expect(result.beforeHit, JSON.stringify(result.beforeHit)).toMatchObject({ inVtt: true, inTabbar: false });
      expect(result.wonWithRealZIndex, 'the toast should still paint above the tab bar with the overflow hatch active').toBe(true);
      expect(result.afterHit, JSON.stringify(result.afterHit)).toMatchObject({ inVtt: true, inTabbar: false });
    } finally {
      await fixture.dispose();
    }
  });
});
