import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';
import { openCockpitTab } from '../lib/encounterCockpit';

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
    // Issue #2158: the AI-DM driver dock has its own Driver tab, distinct from Table.
    await openCockpitTab(page, 'driver');

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
    // Issue #2158: the AI-DM driver dock has its own Driver tab, distinct from Table.
    await openCockpitTab(page, 'driver');
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

test.describe('encounter Driver live session (#1318)', () => {
  test('a player action composes to streamed narration and keeps the encounter link in context', async ({ page }) => {
    const { campaignId, encounterId } = seed();
    let submitted = false;
    const streamWaiters = new Set<() => void>();
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
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    };
    const session = {
      campaignId,
      status: 'idle',
      state: 'running',
      phase: 'active',
      scene: 'The gatehouse',
      lastNarration: null,
      lastTurnAt: null,
      turnCount: 0,
      stuck: null,
      levers: [],
      actingDm: null,
      vote: null,
      takeoverRequestedBy: null,
    };

    await page.route(`**/api/v1/campaigns/${campaignId}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path.endsWith('/events') || path.endsWith('/ai-dm/stream')) {
        const at = '2026-08-09T12:00:00.000Z';
        return new Promise<void>((resolve) => {
          let sent = false;
          const publish = () => {
            if (sent) return;
            sent = true;
            streamWaiters.delete(publish);
            void route.fulfill({
              status: 200,
              contentType: 'text/event-stream',
              body: [
                { type: 'turn.start', campaignId, at },
                { type: 'narration.delta', campaignId, text: 'The portcullis groans open.', at },
                { type: 'narration.message', campaignId, text: 'The portcullis groans open.', at },
                { type: 'tool', campaignId, name: 'next_turn', isError: false, proposed: false, encounterId, at },
                {
                  type: 'transcript',
                  campaignId,
                  at,
                  event: {
                    eventId: 'next-turn-tool',
                    seq: 1,
                    campaignId,
                    kind: 'tool',
                    actorUserId: null,
                    actorName: null,
                    clientRef: null,
                    turnId: 'turn-1',
                    payload: { name: 'next_turn', isError: false, proposed: false, encounterId },
                    at,
                  },
                },
                { type: 'turn.end', campaignId, stopReason: 'complete', steps: 1, tokensUsed: 1, budgetRemaining: 9_999, at },
              ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            }).then(resolve);
          };
          streamWaiters.add(publish);
          if (submitted) publish();
        });
      }
      if (path.endsWith('/ai-dm/message') && method === 'POST') {
        submitted = true;
        for (const publish of streamWaiters) publish();
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      }
      if (path.endsWith('/ai-dm/wrap-up') && method === 'POST') {
        session.phase = 'ended';
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      }
      if (path.endsWith('/ai-dm/session')) return json(session);
      if (path.endsWith('/ai-dm/seat') || (path.endsWith('/ai-dm') && method === 'GET')) return json(seat);
      if (path.endsWith('/ai-dm/tool-confirmations')) return json([]);
      return route.fallback();
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'driver');
    await page.getByTestId('encounter-ai-driver-toggle').click();
    await expect(page.getByRole('button', { name: 'Start Session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wrap Up' })).toBeVisible();

    const composer = page.getByTestId('encounter-ai-driver-composer');
    await composer.getByRole('textbox', { name: 'Your action' }).fill('I lift the gate.');
    const postPromise = page.waitForRequest((request) => request.url().endsWith('/ai-dm/message') && request.method() === 'POST');
    await composer.getByRole('button', { name: 'Send' }).click();
    await postPromise;

    const transcript = page.getByRole('log', { name: 'Driver transcript' });
    await expect(transcript).toContainText('I lift the gate.');
    await expect(transcript).toContainText('The portcullis groans open.', { timeout: 15_000 });
    await expect(transcript.getByRole('link', { name: 'Next turn' })).toHaveAttribute('href', `/c/${campaignId}/encounters/${encounterId}`);

    const wrapRequest = page.waitForRequest(
      (request) => request.url().endsWith('/ai-dm/wrap-up') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Wrap Up' }).click();
    await wrapRequest;
    await expect(composer.getByRole('textbox', { name: 'Your action' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Start Session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wrap Up' })).toHaveCount(0);
  });

  test('a player can restart an ended session from the encounter dock', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('player') });
    const page = await context.newPage();
    try {
      const { campaignId, encounterId, navigation } = seed();
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
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      };
      const session = {
        campaignId,
        status: 'idle',
        state: 'running',
        phase: 'ended',
        scene: null,
        lastNarration: null,
        lastTurnAt: null,
        turnCount: 0,
        stuck: null,
        levers: [],
        actingDm: null,
        vote: null,
        takeoverRequestedBy: null,
      };

      await page.route(`**/api/v1/campaigns/${campaignId}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        const method = route.request().method();
        const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (path.endsWith('/events') || path.endsWith('/ai-dm/stream')) {
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: ': keepalive\n\n',
          });
        }
        if (path.endsWith('/ai-dm/start-session') && method === 'POST') {
          session.phase = 'active';
          return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
        }
        if (path.endsWith('/ai-dm/session')) return json(session);
        if (path.endsWith('/ai-dm/seat') || (path.endsWith('/ai-dm') && method === 'GET')) return json(seat);
        if (path.endsWith('/characters')) return json([{ id: navigation.characterId, name: 'Runa' }]);
        if (path.endsWith('/ai-dm/tool-confirmations')) return json([]);
        return route.fallback();
      });

      await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
      await openCockpitTab(page, 'driver');
      await page.getByTestId('encounter-ai-driver-toggle').click();

      const composer = page.getByTestId('encounter-ai-driver-composer');
      await expect(composer.getByRole('textbox', { name: 'Your action' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Start Session' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Wrap Up' })).toHaveCount(0);

      const startRequest = page.waitForRequest(
        (request) => request.url().endsWith('/ai-dm/start-session') && request.method() === 'POST',
      );
      await page.getByRole('button', { name: 'Start Session' }).click();
      await startRequest;
      await expect(composer.getByRole('textbox', { name: 'Your action' })).toBeEnabled();
    } finally {
      await context.close();
    }
  });
});

test.describe('encounter Driver tab fallback (issue #2158 review)', () => {
  test('falls back to Party if the campaign leaves Driver mode while the Driver tab is selected', async ({ page }) => {
    // The bug this guards: activePanelTab only had a fallback for the Turn tab
    // (`panelTab === 'turn' && !turnTabAvailable ? 'party' : panelTab`) — the Driver tab's
    // own gate (`driverTabAvailable`) controlled the tab array and the VttPanelSection, but
    // nothing re-derived a stale `panelTabChoice` of 'driver' once that gate flipped false.
    // A viewer who picked Driver and then watched the campaign leave Driver mode kept
    // `panelTab === 'driver'` with no tab and no section left to match it: every
    // VttPanelSection stays `hidden`, and the side panel goes blank — worse than the
    // crowded Table tab this issue exists to fix.
    const { campaignId, encounterId } = seed();
    let seatMode: 'driver' | 'off' = 'driver';
    // Set, not a nullable variable, matching "Driver live session" above — deliberately, not
    // just for TS narrowing across the route closure: it also makes "was the stream actually
    // held open" a real, checkable fact (`streamWaiters.size > 0`) rather than a value that
    // could silently still be null.
    const streamWaiters = new Set<() => void>();

    const session = {
      campaignId,
      status: 'idle',
      state: 'running',
      phase: 'active',
      scene: 'Driver-tab fallback drill',
      lastNarration: null,
      lastTurnAt: null,
      turnCount: 0,
      stuck: null,
      levers: [],
      actingDm: null,
      vote: null,
      takeoverRequestedBy: null,
    };

    await page.route(`**/api/v1/campaigns/${campaignId}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path.endsWith('/events') || path.endsWith('/ai-dm/stream')) {
        // Held open until the test explicitly pushes a frame — same technique as the
        // "Driver live session" test above, reused here to push a `state` event: the real
        // signal useAiDmLiveActivity.tsx invalidates the seat query on (alongside
        // 'stuck'/'recovered'/'vote'/'takeover'/'phase'), so the mode change is observed
        // through the same path a real admin-toggled setting would use, not a test-only shortcut.
        return new Promise<void>((resolve) => {
          const publish = () => {
            streamWaiters.delete(publish);
            void route.fulfill({
              status: 200,
              contentType: 'text/event-stream',
              body: `data: ${JSON.stringify({ type: 'state', campaignId, at: '2026-08-10T00:00:00.000Z' })}\n\n`,
            }).then(resolve);
          };
          streamWaiters.add(publish);
        });
      }
      if (path.endsWith('/ai-dm/session')) return json(session);
      if (path.endsWith('/ai-dm/seat') || (path.endsWith('/ai-dm') && method === 'GET')) {
        return json({
          campaignId,
          mode: seatMode,
          enabled: true,
          model: 'test',
          instructions: '',
          tokenBudget: 10_000,
          tokensUsed: 0,
          turnCount: 0,
          lastTurnAt: null,
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
        });
      }
      if (path.endsWith('/ai-dm/tool-confirmations')) return json([]);
      if (path.endsWith('/ai-dm/transcript')) return json({ items: [], nextCursor: null });
      return route.fallback();
    });

    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);
    await openCockpitTab(page, 'driver');
    await expect(page.getByTestId('encounter-ai-driver-panel')).toBeVisible();
    await expect(page.getByTestId('encounter-vtt-tab-driver')).toHaveAttribute('aria-selected', 'true');

    // The campaign leaves Driver mode. Flip the seat GET's response, then push the SSE
    // signal that makes the live app actually notice and refetch.
    seatMode = 'off';
    expect(streamWaiters.size, 'the stream connection must be open before flipping seat mode').toBeGreaterThan(0);
    for (const publish of streamWaiters) publish();

    // Fail-first shape without the fix: `encounter-vtt-tab-driver` disappears (the tab array
    // gate is correct on its own) but `activePanelTab` stays 'driver', so no section has
    // `activeTabId` matching it — `encounter-vtt-panel` keeps rendering (it's the shell,
    // not a per-tab element) but every child section stays `hidden`, and
    // `encounter-ai-driver-panel` never re-renders visible content for a viewer to reach.
    // The named assertions below are what actually distinguishes "fell back correctly" from
    // "went blank but something with a testid still exists somewhere on the page".
    await expect(page.getByTestId('encounter-vtt-tab-driver')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('encounter-vtt-tab-party')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('encounter-vtt-panel')).toBeVisible();
    await expect(page.getByTestId('encounter-ai-driver-panel')).toHaveCount(0);
    // Party's own content actually paints — not merely "the driver dock is gone".
    await expect(page.getByTestId('encounter-vtt-tabpanel-party')).toBeVisible();
  });
});
