import { expect, test, type Page } from '@playwright/test';
import type { AiDmTranscriptEvent } from '@campfire/schema';
import { seed, stateFor } from './seed';

/**
 * Issue #572 — two browsers at the same AI table must see ONE transcript.
 *
 * THE BUG. The server broadcast AI narration/tool/lifecycle events but never the player
 * action that provoked them. Only the sending browser inserted a local optimistic entry, so
 * a second player watched the AI answer a question they never saw. Worse, the transcript
 * itself was rebuilt client-side per browser, so a reload / late join / dropped socket left
 * every player with a different log and no way to recover the missing middle.
 *
 * This drives the real Table UI in TWO browser contexts against one shared, server-shaped
 * transcript (a per-test in-memory store behind the mocked driver routes, standing in for
 * the SQLite table). It pins the behaviours the issue asks for, from the outside:
 *   - the SENDER sees its action exactly once (optimistic echo replaced, not duplicated);
 *   - the OTHER player sees the same action at all — the #572 gap;
 *   - a browser that joins LATE renders the identical transcript from the server;
 *   - a browser whose stream drops recovers the events it missed from its `seq` watermark.
 */

const CAMPAIGN_SEAT = {
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

const CAMPAIGN_SESSION = {
  status: 'active',
  state: 'running',
  scene: 'The bolted door',
  lastNarration: null,
  lastTurnAt: null,
  turnCount: 0,
  stuck: null,
  levers: [],
  actingDm: null,
  vote: null,
  takeoverRequestedBy: null,
};

/** The shared, server-shaped transcript both browsers read from. */
class TranscriptStore {
  private seq = 0;
  readonly events: AiDmTranscriptEvent[] = [];

  constructor(private readonly campaignId: number) {}

  /** Assign the next per-campaign seq and append — the server's write path in miniature. */
  append(partial: Omit<AiDmTranscriptEvent, 'seq' | 'eventId' | 'campaignId' | 'at'>): AiDmTranscriptEvent {
    this.seq += 1;
    const event: AiDmTranscriptEvent = {
      ...partial,
      campaignId: this.campaignId,
      seq: this.seq,
      eventId: `evt-${this.seq}`,
      at: new Date(Date.UTC(2026, 6, 26, 10, 0, this.seq)).toISOString(),
    };
    this.events.push(event);
    return event;
  }

  /** Cursor read: everything strictly after a client's watermark, oldest-first. */
  after(seq: number): AiDmTranscriptEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }
}

function transcriptEvent(
  kind: AiDmTranscriptEvent['kind'],
  payload: Record<string, unknown>,
  extra: Partial<AiDmTranscriptEvent> = {},
): Omit<AiDmTranscriptEvent, 'seq' | 'eventId' | 'campaignId' | 'at'> {
  return { kind, payload, actorUserId: null, actorName: null, clientRef: null, turnId: null, ...extra };
}

/**
 * Mock the driver routes for one page against the shared store.
 *
 * The SSE endpoint replays the frames that exist at connect time and then CLOSES, which is
 * exactly the disconnect the issue cares about: the hook reconnects and the page must
 * gap-fill from its own `seq` watermark. `sseGate` lets a test hold a page offline.
 */
async function mockTable(
  page: Page,
  campaignId: number,
  store: TranscriptStore,
  opts: { sseGate?: () => boolean } = {},
): Promise<void> {
  await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if ((path.endsWith('/ai-dm/stream') || path.endsWith('/events'))) {
      if (opts.sseGate && !opts.sseGate()) {
        // Held "offline": fail the connect so the hook keeps retrying with backoff.
        return route.abort('connectionrefused');
      }
      const body = store.events
        .map((event) => `data: ${JSON.stringify({ type: 'transcript', campaignId, event, at: event.at })}\n\n`)
        .join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `${body}: keepalive\n\n` });
    }

    if (path.endsWith('/ai-dm/transcript')) {
      const after = Number(url.searchParams.get('after') ?? 0);
      const items = store.after(Number.isFinite(after) ? after : 0);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, total: store.events.length, hasMore: false, nextCursor: null, limit: 200 }),
      });
    }

    if (path.endsWith('/ai-dm/session')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ campaignId, ...CAMPAIGN_SESSION }),
      });
    }

    if (path.endsWith('/ai-dm/message') && method === 'POST') {
      // The server's accept path: persist + broadcast the player action, echoing the
      // client's correlation token so the SENDER can replace its optimistic entry.
      const body = route.request().postDataJSON() as { displayText?: string; input: string; clientRef?: string };
      store.append(
        transcriptEvent(
          'player.action',
          { text: body.displayText ?? body.input },
          { actorName: 'Player One', clientRef: body.clientRef ?? null },
        ),
      );
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    }

    if ((path.endsWith('/ai-dm') || path.endsWith('/ai-dm/seat')) && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ campaignId, ...CAMPAIGN_SEAT }),
      });
    }

    return route.fallback();
  });
}

/** Every visible transcript line, in render order. */
async function transcriptLines(page: Page): Promise<string[]> {
  const log = page.getByRole('log', { name: 'Table transcript' });
  await expect(log).toBeVisible();
  return (await log.innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
}

test.describe('AI table: one authoritative transcript across browsers (#572)', () => {
  test.use({ storageState: stateFor('player') });

  test('both players see the same actions, and a dropped client recovers what it missed', async ({ browser }) => {
    const { campaignId } = seed();
    const store = new TranscriptStore(campaignId);
    // Table history that predates BOTH browsers — a late joiner must see it.
    store.append(transcriptEvent('player.action', { text: 'I check the hinges.' }, { actorName: 'Bram' }));
    store.append(transcriptEvent('narration', { text: 'Rust flakes away under your thumb.' }, { turnId: 't1' }));

    const senderCtx = await browser.newContext({ storageState: stateFor('player') });
    const watcherCtx = await browser.newContext({ storageState: stateFor('dm') });

    try {
      const sender = await senderCtx.newPage();
      const watcher = await watcherCtx.newPage();
      await sender.setViewportSize({ width: 900, height: 900 });
      await watcher.setViewportSize({ width: 900, height: 900 });
      await mockTable(sender, campaignId, store);
      await mockTable(watcher, campaignId, store);

      await sender.goto(`/c/${campaignId}/table`);
      await watcher.goto(`/c/${campaignId}/table`);

      // LATE JOIN: both browsers page the authoritative transcript and agree on history.
      for (const page of [sender, watcher]) {
        await expect(page.getByRole('log', { name: 'Table transcript' })).toContainText('I check the hinges.');
        await expect(page.getByRole('log', { name: 'Table transcript' })).toContainText('Rust flakes away under your thumb.');
      }

      // The sender submits. Before #572 this line existed ONLY in the sender's browser.
      await sender.getByLabel('Your action').fill('I shoulder the door.');
      await sender.getByRole('button', { name: 'Send' }).click();

      // SENDER: exactly one line — the optimistic echo was replaced by the authoritative
      // event via `clientRef`, not rendered alongside it.
      await expect
        .poll(async () => (await transcriptLines(sender)).filter((l) => l === 'I shoulder the door.').length, {
          timeout: 20_000,
        })
        .toBe(1);

      // WATCHER: sees the action at all — the whole point of the issue. It arrives on the
      // watcher's next stream connect + gap-fill from its own `seq` watermark.
      await expect
        .poll(async () => (await transcriptLines(watcher)).filter((l) => l === 'I shoulder the door.').length, {
          timeout: 25_000,
        })
        .toBe(1);
    } finally {
      await senderCtx.close();
      await watcherCtx.close();
    }
  });

  test('a client that misses events while disconnected replays exactly them on reconnect', async ({ browser }) => {
    const { campaignId } = seed();
    const store = new TranscriptStore(campaignId);
    store.append(transcriptEvent('narration', { text: 'The corridor is quiet.' }, { turnId: 't0' }));

    let online = true;
    const ctx = await browser.newContext({ storageState: stateFor('player') });
    try {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 900, height: 900 });
      await mockTable(page, campaignId, store, { sseGate: () => online });
      await page.goto(`/c/${campaignId}/table`);
      await expect(page.getByRole('log', { name: 'Table transcript' })).toContainText('The corridor is quiet.');

      // Drop the socket, then let the table move on without this client.
      online = false;
      store.append(transcriptEvent('player.action', { text: 'I sprint for the stair.' }, { actorName: 'Bram' }));
      store.append(transcriptEvent('narration', { text: 'Boots hammer the flagstones.' }, { turnId: 't2' }));

      // Nothing arrives while offline.
      await expect(page.getByRole('log', { name: 'Table transcript' })).not.toContainText('I sprint for the stair.');

      // Reconnect: the client asks for everything after its watermark and catches up in
      // order — including the player action it never saw, which is the #572 gap.
      online = true;
      const log = page.getByRole('log', { name: 'Table transcript' });
      await expect(log).toContainText('I sprint for the stair.', { timeout: 25_000 });
      await expect(log).toContainText('Boots hammer the flagstones.', { timeout: 25_000 });

      const lines = await transcriptLines(page);
      expect(lines.filter((l) => l === 'I sprint for the stair.')).toHaveLength(1);
      expect(lines.indexOf('I sprint for the stair.')).toBeLessThan(lines.indexOf('Boots hammer the flagstones.'));
    } finally {
      await ctx.close();
    }
  });
});
