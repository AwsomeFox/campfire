import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #572 — switching tables must not carry one campaign's transcript into another's,
 * and must not swallow the new table's join context.
 *
 * `/c/:campaignId/table` is a single unkeyed route element, so a param change REUSES the
 * component instance: the reducer's lazy initializer does not re-run and every effect keyed
 * on `campaignId` fires in one commit while `transcript` still holds the previous table's
 * entries. That transition is reachable in the product — the always-mounted notifications
 * bell links straight to `/c/<other>/table` for an ai_dm_alert.
 *
 * Driven through the real router (pushState + popstate is exactly what a client-side
 * navigation does to createBrowserRouter) rather than a reload, because a reload would
 * remount and hide the whole class of bug.
 */

const SEAT = {
  mode: 'driver',
  enabled: true,
  model: 'test',
  instructions: '',
  tokenBudget: 10_000,
  tokensUsed: 0,
  turnCount: 0,
  lastTurnAt: null,
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
};

function session(campaignId: number, scene: string, lastNarration: string | null) {
  return {
    campaignId,
    status: 'active',
    state: 'running',
    scene,
    lastNarration,
    lastTurnAt: null,
    turnCount: 0,
    stuck: null,
    levers: [],
    actingDm: null,
    vote: null,
    takeoverRequestedBy: null,
  };
}

/**
 * Route both campaigns. `transcripts` maps campaign id -> the authoritative events that
 * campaign has; an empty list is the case that matters (a brand-new table whose join
 * context can only come from the session read).
 */
async function mockTables(
  page: Page,
  transcripts: Record<number, unknown[]>,
  scenes: Record<number, string>,
): Promise<void> {
  await page.route('**/api/v1/campaigns/*/ai-dm**', async (route) => {
    const url = new URL(route.request().url());
    const id = Number(url.pathname.split('/')[4]);
    const path = url.pathname;
    if ((path.endsWith('/ai-dm/stream') || path.endsWith('/events'))) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    }
    if (path.endsWith('/ai-dm/transcript')) {
      const items = transcripts[id] ?? [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, total: items.length, hasMore: false, nextCursor: null, limit: 200 }),
      });
    }
    if (path.endsWith('/ai-dm/session')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session(id, scenes[id], null)),
      });
    }
    if (path.endsWith('/ai-dm') && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ campaignId: id, ...SEAT }) });
    }
    return route.fallback();
  });
}

/** Client-side navigation, the way the notifications bell performs one. */
async function navigateClientSide(page: Page, to: string): Promise<void> {
  await page.evaluate((href) => {
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, to);
}

test.describe('AI table campaign switch (#572)', () => {
  test.use({ storageState: stateFor('dm') });

  test('switching tables drops the old transcript and still seeds the new table’s join context', async ({ page }) => {
    const { campaignId } = seed();
    const other = campaignId + 1;

    await page.setViewportSize({ width: 900, height: 900 });
    await mockTables(
      page,
      {
        // The table we start on has real history…
        [campaignId]: [
          {
            eventId: 'evt-a1',
            seq: 1,
            campaignId,
            kind: 'player.action',
            actorUserId: 'u1',
            actorName: 'Runa',
            clientRef: null,
            turnId: null,
            payload: { text: 'I shoulder the door.' },
            at: '2026-07-26T10:00:01.000Z',
          },
        ],
        // …the one we switch to has none, so its join context can only come from the
        // session read. This is the case the seed effect exists for.
        [other]: [],
      },
      { [campaignId]: 'The bolted door', [other]: 'A different table entirely' },
    );

    await page.goto(`/c/${campaignId}/table`);
    const log = page.getByRole('log', { name: 'Table transcript' });
    await expect(log).toContainText('I shoulder the door.');

    await navigateClientSide(page, `/c/${other}/table`);

    // The previous table's transcript must not survive the switch.
    await expect(log).not.toContainText('I shoulder the door.', { timeout: 15_000 });

    // …and the new table must still get its join context. Before the fix, the seed effect
    // saw the OLD campaign's entries in the switch commit, latched seededRef true, and then
    // refused to seed once the (empty) new campaign had hydrated.
    await expect(log).toContainText('A different table entirely', { timeout: 15_000 });
  });
});
