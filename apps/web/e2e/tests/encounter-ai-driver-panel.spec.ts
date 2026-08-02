import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Resolving an AI tool confirmation FROM THE ENCOUNTER PANEL (issue #1494).
 *
 * #1558 shipped the confirmations panel on the AI Table and proved a DM can click Approve there.
 * But a DM mid-combat is on the encounter page, not the Table — and until #1494 the encounter
 * dock had no confirmation handling at all, so `begin_encounter` (confirm-policy in every profile
 * since #474) queued silently and the fight could neither start nor end through the AI. This spec
 * is the thing that closes THAT gap: it drives the real built SPA on the encounter page, opens the
 * driver dock, and asserts the queued call is visible and resolvable right where the DM is looking.
 *
 * Like `ai-tool-confirmations.spec.ts`, the AI-DM reads are `page.route`-stubbed: synthesizing a
 * genuine pending confirmation needs a provider and a confirm-policy tool call mid-turn, which the
 * server suite covers end to end. What is untested elsewhere is the encounter-panel browser half.
 */
test.use({ storageState: stateFor('dm') });

const PENDING = [
  {
    id: 'confirm-begin',
    tool: 'begin_encounter',
    args: { encounterId: 42 },
    toolCallId: 'call_begin',
    profile: 'live',
    policy: 'confirm',
    requestedAt: '2026-07-30T10:00:00.000Z',
    actor: 'ai-dm-seat:1',
    triggeredBy: 'player-1',
    turnNumber: 4,
  },
];

async function mockAiDm(page: Page, campaignId: number, resolved: string[]) {
  const seat = {
    campaignId,
    mode: 'driver',
    enabled: true,
    model: 'test',
    instructions: '',
    tokenBudget: 10_000,
    tokensUsed: 0,
    turnCount: 0,
    lastTurnAt: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
  const session = {
    campaignId,
    status: 'idle',
    state: 'running',
    scene: 'Encounter confirmation test',
    lastNarration: null,
    lastTurnAt: null,
    turnCount: 4,
    stuck: null,
    levers: [],
    actingDm: null,
    vote: null,
    takeoverRequestedBy: null,
  };

  await page.route(`**/api/v1/campaigns/${campaignId}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if ((path.endsWith('/ai-dm/stream') || path.endsWith('/events'))) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    }
    if (path.endsWith('/ai-dm/tool-confirmations')) {
      return json(PENDING.filter((c) => !resolved.includes(c.id)));
    }
    if (path.endsWith('/ai-dm/tool-confirmation') && method === 'POST') {
      const body = route.request().postDataJSON() as { confirmationId: string; action: string };
      resolved.push(`${body.confirmationId}`);
      return json({ confirmation: null });
    }
    if (path.endsWith('/ai-dm/session')) return json(session);
    if (path.endsWith('/ai-dm/seat') || (path.endsWith('/ai-dm') && method === 'GET')) return json(seat);
    if (path.endsWith('/ai-dm/transcript')) return json({ items: [], nextCursor: null });
    return route.fallback();
  });
}

test.describe('encounter panel tool confirmations (#1494)', () => {
  test('a DM mid-encounter sees a queued begin_encounter in the driver dock and approves it', async ({
    page,
  }) => {
    const { campaignId, encounterId } = seed();
    const resolved: string[] = [];
    await mockAiDm(page, campaignId, resolved);

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    // The dock starts collapsed; a DM supervising the AI opens it. The confirmation lives inside
    // the disclosure region, so it must be opened before the panel can render.
    await page.getByTestId('encounter-ai-driver-toggle').click();

    const panel = page.getByTestId('ai-tool-confirmations');
    await expect(panel).toBeVisible();

    // The exact headline tool from the issue — combat that could not start through the AI before.
    const row = page.getByTestId('ai-tool-confirmation-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-tool', 'begin_encounter');

    const postPromise = page.waitForRequest(
      (req) => req.url().includes('/ai-dm/tool-confirmation') && req.method() === 'POST',
    );
    await row.getByTestId('ai-tool-confirmation-approve').click();
    const post = await postPromise;

    // THE ASSERTION THIS ISSUE EXISTS FOR: the approval left the encounter-panel browser because
    // someone clicked, not because a test called the API — the thing that was structurally
    // impossible here before #1494.
    expect(post.postDataJSON()).toMatchObject({ action: 'approve', confirmationId: 'confirm-begin' });

    // ...and the resolved call leaves the queue.
    await expect(panel).toHaveCount(0);
  });

  test('a player never sees the panel from the encounter dock either', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('player') });
    const page = await context.newPage();
    try {
    const { campaignId, encounterId } = seed();
    await mockAiDm(page, campaignId, []);
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    // The endpoint is DM-only and the query is disabled for anyone else, so even with the dock
    // open there is nothing to render and no 403 drip.
    const toggle = page.getByTestId('encounter-ai-driver-toggle');
    // Use a direct locator-attached check rather than catching every locator error, so a real
    // failure (e.g. a thrown timeout) surfaces instead of being masked as "toggle absent".
    if (await toggle.count() > 0 && (await toggle.first().isVisible())) {
      await toggle.first().click();
    }
    await expect(page.getByTestId('ai-tool-confirmations')).toHaveCount(0);
    } finally {
      // Always release the browser context even if an assertion above throws, so a leaked
      // context cannot keep the page alive past this test.
      await context.close();
    }
  });
});
