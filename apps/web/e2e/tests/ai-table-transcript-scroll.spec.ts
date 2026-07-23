import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';
import { transcriptStorageKey, type TranscriptEntry } from '../../src/features/ai-dm/transcript';

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
    if (path.endsWith('/ai-dm/stream')) {
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

test.describe('AI table transcript scroll (#590)', () => {
  test('opens at the latest line when the transcript is hydrated from storage', async ({ page }) => {
    const { campaignId } = seed();
    const entries = seedLongTranscript(campaignId);
    await page.setViewportSize({ width: 800, height: 520 });
    await mockDriverTable(page, campaignId);
    await page.addInitScript(
      ({ key, payload }) => {
        localStorage.setItem(key, payload);
      },
      { key: transcriptStorageKey(campaignId), payload: JSON.stringify({ entries }) },
    );

    await page.goto(`/c/${campaignId}/table`);
    const transcript = page.getByRole('log', { name: 'Table transcript' });
    await expect(transcript).toBeVisible();
    await expect.poll(async () => {
      const jump = page.getByTestId('transcript-jump-latest');
      if (await jump.isVisible()) return true;
      return transcript.getByText('Earlier table line 80').evaluate((el) => {
        const row = el.getBoundingClientRect();
        const pane = el.closest('[role="log"]')!.getBoundingClientRect();
        return row.top >= pane.top - 4 && row.bottom <= pane.bottom + 4;
      });
    }).toBe(true);
  });

  test('stops tail follow when reading history and offers jump-to-latest with unread count', async ({ page }) => {
    const { campaignId } = seed();
    const entries = seedLongTranscript(campaignId);
    await page.setViewportSize({ width: 800, height: 520 });
    await mockDriverTable(page, campaignId);
    await page.addInitScript(
      ({ key, payload }) => {
        localStorage.setItem(key, payload);
      },
      { key: transcriptStorageKey(campaignId), payload: JSON.stringify({ entries }) },
    );

    await page.goto(`/c/${campaignId}/table`);
    const transcript = page.getByRole('log', { name: 'Table transcript' });
    await expect(transcript).toHaveAttribute('aria-live', 'off');
    await expect(page.getByTestId('ai-narration-log')).toHaveAttribute('role', 'log');

    await transcript.focus();
    await transcript.evaluate((node) => {
      node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const scrollBefore = await transcript.evaluate((node) => node.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

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
