import { expect, test, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';
import { transcriptStorageKey, type TranscriptEntry } from '../../src/features/ai-dm/transcript';
import { transcriptRememberKey } from '../../src/features/ai-dm/transcriptPrivacy';

test.use({ storageState: stateFor('player') });

function driverAiDmRoutes(campaignId: number) {
  return {
    seat: {
      campaignId,
      mode: 'driver',
      enabled: true,
      model: 'test',
      instructions: '',
      tokenBudget: 10_000,
      tokensUsed: 0,
      turnCount: 0,
      lastTurnAt: null,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    session: {
      campaignId,
      status: 'active',
      state: 'running',
      scene: 'Scroll test scene',
      lastNarration: null,
      lastTurnAt: null,
      turnCount: 0,
      stuck: null,
      levers: [],
      actingDm: null,
      vote: null,
      takeoverRequestedBy: null,
    },
  };
}

async function mockDriverTable(page: Page, campaignId: number) {
  const fixtures = driverAiDmRoutes(campaignId);
  await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if ((path.endsWith('/ai-dm/stream') || path.endsWith('/events'))) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    }
    if (path.endsWith('/ai-dm/seat')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.seat) });
    }
    if (path.endsWith('/ai-dm/session')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.session) });
    }
    if (path.endsWith('/ai-dm') && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.seat) });
    }
    if (path.endsWith('/ai-dm/message') && route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fallback();
  });
}

function seedLongTranscript(_campaignId: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < 80; i += 1) {
    entries.push({
      id: `hist-${i}`,
      kind: 'player',
      memberName: 'Historian',
      text: `Earlier table line ${i + 1} with enough text to make the transcript scroll independently`,
      at: `2026-07-22T10:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  return entries;
}

/**
 * Prime the transcript paint cache the way the app itself would (#573).
 *
 * Two keys, not one. Since #573 the cache is namespaced by the AUTHENTICATED USER, and it
 * is only read when that user has opted into remembering transcripts on this device — the
 * default is off, so seeding the transcript key alone now loads nothing. Reading the id
 * from `/me` rather than hardcoding it keeps this honest: if namespacing regressed to a
 * shared key, these specs would still pass, so they have to go through the real key
 * builder with the real id.
 */
async function seedTranscriptCache(page: Page, campaignId: number, entries: TranscriptEntry[]): Promise<void> {
  const me = await page.request.get('/api/v1/me');
  expect(me.ok()).toBe(true);
  const userId: number = (await me.json()).user.id;
  const key = transcriptStorageKey(userId, campaignId);
  expect(key).not.toBeNull();
  const grantKey = transcriptRememberKey(userId);
  expect(grantKey).not.toBeNull();
  await page.addInitScript(
    ({ key: k, grantKey: g, payload }) => {
      localStorage.setItem(g, '1');
      localStorage.setItem(k, payload);
    },
    { key: key!, grantKey: grantKey!, payload: JSON.stringify({ entries }) },
  );
}

test.describe('AI table transcript scroll (#590)', () => {
/**
 * Wait until the transcript's MOUNT tail-pin has fully settled (#590).
 *
 * `pinTranscriptToTail` suppresses scroll-unpin for two animation frames and then
 * RE-PINS if follow is still intended. A scroll issued while that window is open is
 * therefore either ignored outright or undone a frame later, leaving the transcript
 * pinned, `unreadBelow` reset to 0, and no jump affordance — so any assertion about
 * leaving the tail races the mount rather than testing the follow state machine.
 * Settled means: no jump button, and scrollTop within 48px of the maximum.
 */
async function expectTailPinned(page: Page, transcript: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const jumpCount = await page.getByTestId('transcript-jump-latest').count();
        const { top, max } = await transcript.evaluate((node) => ({
          top: node.scrollTop,
          max: node.scrollHeight - node.clientHeight,
        }));
        return jumpCount === 0 && max > 0 && max - top <= 48;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

  test('opens at the latest line when the transcript is hydrated from storage', async ({ page }) => {
    const { campaignId } = seed();
    const entries = seedLongTranscript(campaignId);
    // Tall enough that the transcript keeps a real overflow box after chrome/combat
    // banners settle — short 520px viewports crushed clientHeight to ~50px in CI.
    await page.setViewportSize({ width: 800, height: 900 });
    await mockDriverTable(page, campaignId);
    await seedTranscriptCache(page, campaignId, entries);

    await page.goto(`/c/${campaignId}/table`);
    const transcript = page.getByRole('log', { name: 'Table transcript' });
    await expect(transcript).toBeVisible();
    // Wait for mount tail-pin: no jump affordance and scroll near the latest line.
    // Flex layout / font settle on CI can leave the jump button visible for a frame
    // if we assert count===0 before scrollTop catches up (#590).
    await expectTailPinned(page, transcript);
    await expect(transcript.getByText('Earlier table line 80')).toBeVisible();
  });

  test('stops tail follow when reading history and offers jump-to-latest with unread count', async ({ page }) => {
    const { campaignId } = seed();
    const entries = seedLongTranscript(campaignId);
    await page.setViewportSize({ width: 800, height: 900 });
    await mockDriverTable(page, campaignId);
    await seedTranscriptCache(page, campaignId, entries);

    await page.goto(`/c/${campaignId}/table`);
    const transcript = page.getByRole('log', { name: 'Table transcript' });
    await expect(transcript).toHaveAttribute('aria-live', 'off');
    await expect(page.getByTestId('ai-narration-log')).toHaveAttribute('role', 'log');

    // The sibling test above waits for the mount tail-pin before asserting; this one
    // scrolled away immediately, so on a slow machine the scroll could land inside
    // pinTranscriptToTail's two-frame suppression window and be swallowed (or undone by
    // its trailing re-pin). Follow then stayed engaged, the send below cleared unreadBelow
    // instead of incrementing it, and the jump-to-latest assertions failed — which is the
    // shape this spec kept failing in on CI and recovering from on retry.
    await expectTailPinned(page, transcript);

    await transcript.focus();
    await transcript.evaluate((node) => {
      node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect.poll(async () => transcript.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    const scrollBefore = await transcript.evaluate((node) => node.scrollTop);

    await page.getByTestId('ai-table-composer').getByRole('textbox', { name: 'Your action' }).fill('I scout ahead.');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('transcript-jump-latest')).toBeVisible();
    await expect(page.getByTestId('transcript-jump-latest')).toContainText('1 new');
    expect(await transcript.evaluate((node) => node.scrollTop)).toBe(scrollBefore);

    await page.getByTestId('transcript-jump-latest').click();
    await expect.poll(async () => {
      const { top, max } = await transcript.evaluate((node) => ({
        top: node.scrollTop,
        max: node.scrollHeight - node.clientHeight,
      }));
      return max - top;
    }).toBeLessThanOrEqual(48);
    await expect(page.getByTestId('transcript-jump-latest')).toHaveCount(0);
  });
});
