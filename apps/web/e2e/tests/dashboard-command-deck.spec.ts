import AxeBuilder from '@axe-core/playwright';
import { expect, request, test } from '@playwright/test';
import { CREDS } from '../global-setup';
import { seed, stateFor } from './seed';

/**
 * The campaign dashboard's three-pane command deck, from the Claude Design template
 * `templates/campaign-dashboard/CampaignDashboard.dc.html`.
 *
 * Claims a browser has to settle:
 *  - the deck really is three panes at 2xl and one column on a phone, in the print/reading
 *    order the design puts them in (session and party first);
 *  - the dice tray is pinned OUTSIDE the rail's tabpanels, so switching tabs never takes the
 *    thing a table reaches for most out from under it;
 *  - the Checks tab is DM-only — a player must not be offered a control the endpoint refuses.
 */
test.describe('dashboard command deck', () => {
  test.describe('as the DM', () => {
    test.use({ storageState: stateFor('dm') });

    test('the deck is three panes wide and one column on a phone', async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}`);

      const sessionRail = page.getByTestId('dashboard-session-rail');
      const tableRail = page.getByTestId('dashboard-table-rail');
      await expect(sessionRail).toBeVisible();
      await expect(tableRail).toBeVisible();

      // Three panes: both rails sit beside the world column, not above or below it.
      const railBox = (await sessionRail.boundingBox())!;
      const talkBox = (await tableRail.boundingBox())!;
      const mapBox = (await page.getByTestId('dashboard-map').boundingBox())!;
      expect(railBox.x + railBox.width).toBeLessThanOrEqual(mapBox.x + 1);
      expect(talkBox.x).toBeGreaterThanOrEqual(mapBox.x + mapBox.width - 1);

      // On a phone it is one column, and the session rail leads — the design's order, and the
      // one a table wants: next session and party before the world.
      await page.setViewportSize({ width: 390, height: 844 });
      const narrowRail = (await sessionRail.boundingBox())!;
      const narrowMap = (await page.getByTestId('dashboard-map').boundingBox())!;
      expect(narrowRail.y + narrowRail.height).toBeLessThanOrEqual(narrowMap.y + 1);

      // ...and at the narrowest size we support, the deck must not push the page sideways.
      // The world column's auto-fit track has a 20rem floor, which is WIDER than a 320px
      // viewport once the page's own padding is taken out — a bare floor cannot shrink and
      // scrolls the whole document horizontally.
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const overflow = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          view: document.documentElement.clientWidth,
        }));
        expect(overflow.doc, `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(overflow.view);
      }
    });

    test('the dice tray survives a tab switch — it is pinned, not in a panel', async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}`);

      const rail = page.getByTestId('dashboard-table-rail');
      const dice = rail.getByTestId('shared-dice-log');
      await expect(dice).toBeVisible();

      for (const name of ['Checks', 'Talk', 'Notes']) {
        await rail.getByRole('tab', { name }).click();
        await expect(rail.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
        await expect(dice, `dice tray must survive the ${name} tab`).toBeVisible();
      }
    });

    test('the rail tablist is keyboard operable and axe-clean', async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}`);

      const rail = page.getByTestId('dashboard-table-rail');
      await rail.getByRole('tab', { name: 'Notes' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(rail.getByRole('tab', { name: 'Checks' })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('End');
      await expect(rail.getByRole('tab', { name: 'Talk' })).toHaveAttribute('aria-selected', 'true');
      // Wrapping is computed over the tabs this viewer actually has, so End then ArrowRight
      // returns to the first rather than landing on a tab that isn't rendered.
      await page.keyboard.press('ArrowRight');
      await expect(rail.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');

      const results = await new AxeBuilder({ page }).include('[data-testid="dashboard-table-rail"]').analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
    });

    test('the open tab is visibly marked, not just announced', async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}`);

      const rail = page.getByTestId('dashboard-table-rail');
      // `.seg-opt`'s own highlight is `:has(input:checked)`-gated and these are plain buttons,
      // so a sighted user had nothing to read: every tab rendered identically.
      const ring = (name: string) =>
        rail.getByRole('tab', { name }).evaluate((el) => getComputedStyle(el).boxShadow);
      expect(await ring('Notes')).not.toBe('none');
      expect(await ring('Talk')).toBe('none');

      await rail.getByRole('tab', { name: 'Talk' }).click();
      expect(await ring('Talk')).not.toBe('none');
      expect(await ring('Notes')).toBe('none');
    });

    /**
     * The tray is only "pinned" if the panel row above it is actually bounded. `h-full` was not:
     * `height:100%` resolves against the parent's HEIGHT and the aside carries only
     * `max-height`, so it computed to `auto`, the grid sized to its content, and a long
     * discussion pushed the tray below the fold — the exact regression the restructure was
     * meant to fix. This drives it with a discussion tall enough to overflow.
     */
    test('a long panel scrolls under the tray rather than pushing it off screen', async ({ page, baseURL }) => {
      const ctx = await request.newContext({ baseURL: baseURL! });
      await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
      const campaign = await (await ctx.post('/api/v1/campaigns', { data: { name: 'Deck Tall Rail' } })).json();
      for (let i = 0; i < 18; i += 1) {
        await ctx.post(`/api/v1/campaigns/${campaign.id}/comments`, {
          data: { entityType: 'campaign', entityId: campaign.id, body: `DECKTALL filler comment ${i} — long enough to grow the panel well past the viewport.` },
        });
      }
      await ctx.dispose();

      try {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(`/c/${campaign.id}`);
        const rail = page.getByTestId('dashboard-table-rail');
        await rail.getByRole('tab', { name: 'Talk' }).click();
        await expect(rail.getByTestId('shared-dice-log')).toBeVisible();

        // The claim is about the rail's own box, not where the page happens to be scrolled: the
        // rail is sticky, so at scroll 0 it sits below whatever leads the page. What must hold is
        // that the PANEL ROW is bounded and takes the overflow itself — with `h-full` resolving
        // to `auto` the grid grew to its content instead, the row never scrolled, and the tray
        // was pushed past the rail's own height.
        const box = await rail.evaluate((aside) => {
          const root = aside.firstElementChild as HTMLElement;
          const panels = root.children[1] as HTMLElement;
          return {
            railHeight: root.getBoundingClientRect().height,
            railMaxHeight: parseFloat(getComputedStyle(root).maxHeight),
            panelsScroll: panels.scrollHeight,
            panelsClient: panels.clientHeight,
          };
        });
        expect(box.railMaxHeight, 'the rail must carry a resolved viewport bound').toBeGreaterThan(0);
        expect(box.railHeight, 'the rail must not grow past its bound').toBeLessThanOrEqual(box.railMaxHeight + 1);
        expect(box.panelsScroll, 'the panel row must take the overflow').toBeGreaterThan(box.panelsClient);
      } finally {
        const cleanup = await request.newContext({ baseURL: baseURL! });
        await cleanup.post('/api/v1/auth/login', { data: CREDS.dm });
        await cleanup.delete(`/api/v1/campaigns/${campaign.id}`);
        await cleanup.delete(`/api/v1/campaigns/${campaign.id}/purge`);
        await cleanup.dispose();
      }
    });

    /**
     * `entityHref` builds a campaign comment as `/c/:id?comment=N#entity-comment-N`, and
     * `EntityDeepLinkFocus` focuses that node. A `display:none` node cannot be focused or
     * scrolled to, so once the discussion moved behind a tab these links — from notifications,
     * search results and mentions — opened the dashboard and did nothing visible.
     */
    test('a deep link to a campaign comment opens the tab that holds it', async ({ page, baseURL }) => {
      const { campaignId } = seed();
      const ctx = await request.newContext({ baseURL: baseURL! });
      await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
      const posted = await ctx.post(`/api/v1/campaigns/${campaignId}/comments`, {
        data: { entityType: 'campaign', entityId: campaignId, body: 'DECKLINK anchor comment' },
      });
      expect(posted.ok()).toBeTruthy();
      const commentId = (await posted.json()).id as number;
      await ctx.dispose();

      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}?comment=${commentId}#entity-comment-${commentId}`);

      const rail = page.getByTestId('dashboard-table-rail');
      await expect(rail.getByRole('tab', { name: 'Talk' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`#entity-comment-${commentId}`)).toBeVisible();
    });
  });

  /**
   * `CheckRequestPanel` is DM-only — `POST /campaigns/:id/check-requests` requires it. A player
   * must not be shown the tab at all; the roving tabindex and arrow-key wrap are built from the
   * same list, so a viewer who cannot use the tab cannot reach it by keyboard either.
   */
  test.describe('as a player', () => {
    test.use({ storageState: stateFor('player') });

    test('the Checks tab is absent, and the rest of the rail still works', async ({ page }) => {
      const { campaignId } = seed();
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}`);

      const rail = page.getByTestId('dashboard-table-rail');
      await expect(rail.getByRole('tab', { name: 'Notes' })).toBeVisible();
      await expect(rail.getByRole('tab', { name: 'Talk' })).toBeVisible();
      await expect(rail.getByRole('tab', { name: 'Checks' })).toHaveCount(0);
      await expect(page.getByTestId('request-check-panel')).toHaveCount(0);

      await rail.getByRole('tab', { name: 'Notes' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(rail.getByRole('tab', { name: 'Talk' })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(rail.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  /**
   * Print is a document, not a deck: the grid collapses and the rails stop pinning to a viewport
   * paper does not have. Asserted through the same `.cf-print-*` seam the character sheet uses.
   */
  test.describe('print', () => {
    test.use({ storageState: stateFor('dm') });

    test('the deck collapses to one column on paper', async ({ page, baseURL }) => {
      const ctx = await request.newContext({ baseURL: baseURL! });
      await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
      await ctx.dispose();

      const { campaignId } = seed();
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/c/${campaignId}`);
      await expect(page.getByTestId('dashboard-session-rail')).toBeVisible();

      await page.emulateMedia({ media: 'print' });
      const deckDisplay = await page.locator('.cf-dashboard-deck').evaluate((el) => getComputedStyle(el).display);
      expect(deckDisplay).toBe('block');
      const railPosition = await page.getByTestId('dashboard-session-rail').evaluate((el) => getComputedStyle(el).position);
      expect(railPosition).toBe('static');

      // Paper wants the WHOLE rail, whichever tab was open on screen. Native `hidden` cannot be
      // overridden by a print stylesheet, which is why the inactive panels carry a class instead.
      for (const id of ['dashboard-rail-panel-notes', 'dashboard-rail-panel-checks', 'dashboard-rail-panel-talk']) {
        const display = await page.locator(`#${id}`).evaluate((el) => getComputedStyle(el).display);
        expect(display, `${id} must print`).not.toBe('none');
      }
      await page.emulateMedia({ media: 'screen' });
      // ...and back on screen only the open one shows.
      const talkOnScreen = await page.locator('#dashboard-rail-panel-talk').evaluate((el) => getComputedStyle(el).display);
      expect(talkOnScreen).toBe('none');
    });
  });
});
