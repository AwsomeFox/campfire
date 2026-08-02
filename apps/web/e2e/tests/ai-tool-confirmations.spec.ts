import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Approving an AI tool confirmation THROUGH THE UI (issue #1558).
 *
 * PR #1557's e2e approves over HTTP, and said so explicitly, because no UI existed to click.
 * That test is a marker for this gap; this one is the thing that closes it. It drives the real
 * built SPA in a real browser as a real DM and asserts that pressing Approve issues the POST —
 * which is precisely what could not be done before, by any spelling.
 *
 * The AI-DM reads are `page.route`-stubbed rather than driven by a live model: producing a
 * genuine pending confirmation needs a provider and a confirm-policy tool call mid-turn, which
 * the server suite already covers end to end. What is untested anywhere else, and what this
 * covers, is the browser half — the panel rendering the queue, and the button reaching the
 * endpoint.
 */
test.use({ storageState: stateFor('dm') });

const PENDING = [
  {
    id: 'confirm-1',
    tool: 'update_character_hp',
    args: { characterId: 999_001, hpDelta: -7 },
    toolCallId: 'call_1',
    profile: 'live',
    policy: 'confirm',
    requestedAt: '2026-07-27T10:00:00.000Z',
    actor: 'ai-dm-seat:1',
    triggeredBy: 'player-1',
    turnNumber: 4,
  },
  {
    id: 'confirm-2',
    tool: 'begin_encounter',
    args: { encounterId: 42 },
    toolCallId: 'call_2',
    profile: 'live',
    policy: 'confirm',
    requestedAt: '2026-07-27T10:00:05.000Z',
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
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
  const session = {
    campaignId,
    status: 'idle',
    state: 'running',
    scene: 'Confirmation test',
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

test.describe('AI tool confirmations (#1558)', () => {
  test('a DM sees the pending queue on the AI Table and approves it by clicking', async ({ page }) => {
    const { campaignId } = seed();
    const resolved: string[] = [];
    await mockAiDm(page, campaignId, resolved);

    await page.goto(`/c/${campaignId}/table`);

    const panel = page.getByTestId('ai-tool-confirmations');
    await expect(panel).toBeVisible();

    // Multi-pending is the NORMAL case under collaborative handoff (#1051) — roughly four per
    // combat turn — so the panel has to be a list, and the count has to be honest.
    await expect(page.getByTestId('ai-tool-confirmations-count')).toHaveText('2');
    const rows = page.getByTestId('ai-tool-confirmation-row');
    await expect(rows).toHaveCount(2);

    // The waiting state is LEGIBLE: a decision, not a function signature. "Approve
    // update_character_hp?" is not an informed decision; this is.
    await expect(panel).toContainText('Deal 7 damage to');
    await expect(panel).toContainText('waiting');

    // Oldest first — the order the AI proposed them in.
    await expect(rows.first()).toHaveAttribute('data-tool', 'update_character_hp');

    const postPromise = page.waitForRequest(
      (req) => req.url().includes('/ai-dm/tool-confirmation') && req.method() === 'POST',
    );
    await rows.first().getByTestId('ai-tool-confirmation-approve').click();
    const post = await postPromise;

    // THE ASSERTION THIS ISSUE EXISTS FOR: the approval left the browser because someone
    // clicked, not because a test called the API.
    expect(post.postDataJSON()).toMatchObject({ action: 'approve', confirmationId: 'confirm-1' });

    // ...and the resolved item leaves the queue.
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('ai-tool-confirmations-count')).toHaveText('1');
  });

  test('rejecting sends the reject action, and the raw arguments are one disclosure away', async ({ page }) => {
    const { campaignId } = seed();
    const resolved: string[] = [];
    await mockAiDm(page, campaignId, resolved);
    await page.goto(`/c/${campaignId}/table`);

    const rows = page.getByTestId('ai-tool-confirmation-row');
    await expect(rows).toHaveCount(2);

    // The summary is lossy by design; a DM must always be able to see the whole call rather than
    // approve on the strength of a sentence.
    await rows.first().getByRole('group').click();
    await expect(rows.first()).toContainText('hpDelta');

    const postPromise = page.waitForRequest(
      (req) => req.url().includes('/ai-dm/tool-confirmation') && req.method() === 'POST',
    );
    await rows.first().getByTestId('ai-tool-confirmation-reject').click();
    expect((await postPromise).postDataJSON()).toMatchObject({ action: 'reject' });
  });

  test('a player never sees the panel', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('player') });
    const page = await context.newPage();
    const { campaignId } = seed();
    await mockAiDm(page, campaignId, []);
    await page.goto(`/c/${campaignId}/table`);
    // The endpoint is DM-only; the query is disabled for anyone else, so there is nothing to
    // render and no 403 drip either.
    await expect(page.getByTestId('ai-tool-confirmations')).toHaveCount(0);
    await context.close();
  });
});
