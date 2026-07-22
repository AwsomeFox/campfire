import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type LadderState = 'running' | 'awaiting_players' | 'paused' | 'human_control';
type SessionStatus = 'idle' | 'running' | 'paused';

interface RuntimeFixture {
  status: SessionStatus;
  state: LadderState;
  messageBehavior: 'success' | 'error' | 'hold';
  messagePosts: number;
  releaseMessage?: () => void;
}

const streamHarness = () => {
  const originalFetch = window.fetch.bind(window);
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const testWindow = window as typeof window & {
    __emitAiTableEvent(event: unknown): void;
    __disconnectAiTableStreams(): void;
    __aiTableStreamCount(): number;
  };

  testWindow.__emitAiTableEvent = (event: unknown) => {
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const controller of streams) controller.enqueue(frame);
  };
  testWindow.__disconnectAiTableStreams = () => {
    for (const controller of streams) controller.close();
    streams.clear();
  };
  testWindow.__aiTableStreamCount = () => streams.size;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.endsWith('/ai-dm/stream')) return originalFetch(input, init);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.add(controller);
        init?.signal?.addEventListener('abort', () => {
          if (!streams.delete(controller)) return;
          try {
            controller.close();
          } catch {
            // It may already have been closed by the reconnect fixture.
          }
        });
      },
      cancel() {
        // The hook's AbortController owns cleanup; Set.delete is idempotent.
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
};

async function installTableFixture(page: Page, campaignIds: number[], runtime: RuntimeFixture) {
  await page.addInitScript(streamHarness);

  for (const campaignId of campaignIds) {
    await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          campaignId,
          mode: 'driver',
          tokenBudget: 10_000,
          tokensUsed: 100,
          instructions: '',
        }),
      });
    });
    await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm/session`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          campaignId,
          status: runtime.status,
          state: runtime.state,
          scene: null,
          lastNarration: null,
          lastTurnAt: null,
          turnCount: 0,
          stuck: runtime.state === 'awaiting_players'
            ? { reason: 'tool_error', detail: 'Fixture', since: new Date(0).toISOString(), turn: 1 }
            : null,
          levers: [],
          actingDm: runtime.state === 'human_control'
            ? { memberId: 'fixture-dm', grantedBy: 'fixture-dm', grantedAt: new Date(0).toISOString(), note: null }
            : null,
          vote: null,
          takeoverRequestedBy: null,
        }),
      });
    });
    await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm/message`, async (route) => {
      runtime.messagePosts += 1;
      if (runtime.messageBehavior === 'error') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Fixture provider unavailable.' }),
        });
        return;
      }
      if (runtime.messageBehavior === 'hold') {
        await new Promise<void>((resolve) => {
          runtime.releaseMessage = resolve;
        });
      }
      await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });
  }
}

async function emit(page: Page, campaignId: number, event: Record<string, unknown>) {
  await page.evaluate(({ campaignId: id, event: payload }) => {
    const testWindow = window as typeof window & { __emitAiTableEvent(event: unknown): void };
    testWindow.__emitAiTableEvent({ campaignId: id, at: new Date().toISOString(), ...payload });
  }, { campaignId, event });
}

async function waitForStreams(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const testWindow = window as typeof window & { __aiTableStreamCount(): number };
    return testWindow.__aiTableStreamCount();
  })).toBeGreaterThan(0);
}

function sendStatus(page: Page) {
  return page.getByTestId('ai-table-composer').getByRole('status');
}

test.describe('AI Table local drafting', () => {
  test.use({ storageState: stateFor('dm'), serviceWorkers: 'block' });

  test('preserves edits through rapid live states, reconnect, route changes, reload, errors, and in-flight success', async ({ page }) => {
    const { campaignId } = seed();
    const runtime: RuntimeFixture = {
      status: 'running',
      state: 'running',
      messageBehavior: 'success',
      messagePosts: 0,
    };
    await installTableFixture(page, [campaignId], runtime);
    await page.goto(`/c/${campaignId}/table`);
    await waitForStreams(page);

    const editor = page.getByRole('textbox', { name: 'Your action' });
    const scene = page.getByRole('textbox', { name: 'Scene for this action (optional)' });
    const send = page.getByRole('button', { name: 'Send' });
    await editor.fill('I study the sealed arch while the table catches up.');
    await scene.fill('Beneath the moon gate');
    await expect(editor).toBeEnabled();
    await expect(scene).toBeEnabled();
    await expect(send).toBeDisabled();
    await expect(sendStatus(page)).toContainText('Another turn is active');

    runtime.status = 'paused';
    runtime.state = 'paused';
    await emit(page, campaignId, { type: 'state', state: 'paused' });
    await expect(sendStatus(page)).toContainText('AI DM is paused');
    await expect(editor).toHaveValue('I study the sealed arch while the table catches up.');

    runtime.status = 'paused';
    runtime.state = 'human_control';
    await emit(page, campaignId, { type: 'state', state: 'human_control' });
    await expect(sendStatus(page)).toContainText('human has the DM seat');

    runtime.status = 'idle';
    runtime.state = 'awaiting_players';
    await emit(page, campaignId, { type: 'state', state: 'awaiting_players' });
    await expect(sendStatus(page)).toContainText('waiting on the table');

    runtime.status = 'running';
    runtime.state = 'running';
    await emit(page, campaignId, { type: 'turn.start' });
    await expect(sendStatus(page)).toContainText('Another turn is active');
    expect(runtime.messagePosts).toBe(0); // State changes never auto-send a local draft.

    await page.evaluate(() => {
      const testWindow = window as typeof window & { __disconnectAiTableStreams(): void };
      testWindow.__disconnectAiTableStreams();
    });
    await expect(sendStatus(page)).toContainText('Reconnecting to the live table');
    runtime.status = 'idle';
    await expect(editor).toHaveValue('I study the sealed arch while the table catches up.');
    await expect(send).toBeEnabled({ timeout: 5_000 });

    await page.goto(`/c/${campaignId}`);
    await page.goto(`/c/${campaignId}/table`);
    await expect(editor).toHaveValue('I study the sealed arch while the table catches up.');
    await page.reload();
    await expect(editor).toHaveValue('I study the sealed arch while the table catches up.');
    await expect(scene).toHaveValue('Beneath the moon gate');

    runtime.messageBehavior = 'error';
    await send.click();
    await expect(page.getByTestId('ai-table-composer').getByRole('alert')).toContainText('Fixture provider unavailable.');
    await expect(editor).toHaveValue('I study the sealed arch while the table catches up.');

    runtime.messageBehavior = 'hold';
    await send.click();
    await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await editor.fill('My next action, drafted while the first request finishes.');
    runtime.releaseMessage?.();
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await expect(editor).toHaveValue('My next action, drafted while the first request finishes.');
  });

  test('isolates campaign drafts and requires an accessible confirmation before discard', async ({ page }) => {
    const fixture = seed();
    const campaignIds = [fixture.campaignId, fixture.semantic.campaignId];
    const runtime: RuntimeFixture = {
      status: 'idle',
      state: 'running',
      messageBehavior: 'success',
      messagePosts: 0,
    };
    await installTableFixture(page, campaignIds, runtime);

    await page.goto(`/c/${fixture.campaignId}/table`);
    await page.getByRole('textbox', { name: 'Your action' }).fill('Cinderhaven draft');
    await page.getByRole('textbox', { name: 'Scene for this action (optional)' }).fill('Cinderhaven scene');

    await page.goto(`/c/${fixture.semantic.campaignId}/table`);
    await expect(page.getByRole('textbox', { name: 'Your action' })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: 'Scene for this action (optional)' })).toHaveValue('');
    await page.getByRole('textbox', { name: 'Your action' }).fill('Semantic campaign draft');

    await page.goto(`/c/${fixture.campaignId}/table`);
    const editor = page.getByRole('textbox', { name: 'Your action' });
    await expect(editor).toHaveValue('Cinderhaven draft');
    await expect(page.getByRole('textbox', { name: 'Scene for this action (optional)' })).toHaveValue('Cinderhaven scene');

    await page.getByRole('button', { name: 'Discard draft' }).click();
    const dialog = page.getByRole('dialog', { name: 'Discard this draft?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('permanently removed')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor).toHaveValue('Cinderhaven draft');

    await page.getByRole('button', { name: 'Discard draft' }).click();
    await dialog.getByRole('button', { name: 'Discard draft' }).click();
    await expect(editor).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Discard draft' })).toHaveCount(0);

    await page.goto(`/c/${fixture.semantic.campaignId}/table`);
    await expect(page.getByRole('textbox', { name: 'Your action' })).toHaveValue('Semantic campaign draft');
  });

  test('handles IME composition and mobile Enter without implicit submission and passes axe', async ({ page }) => {
    const { campaignId } = seed();
    const runtime: RuntimeFixture = {
      status: 'idle',
      state: 'running',
      messageBehavior: 'success',
      messagePosts: 0,
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await installTableFixture(page, [campaignId], runtime);
    await page.goto(`/c/${campaignId}/table`);

    const editor = page.getByRole('textbox', { name: 'Your action' });
    await editor.fill('扉を調べる');
    await editor.dispatchEvent('compositionstart', { data: 'る' });
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(sendStatus(page)).toContainText('Finish composing');
    await editor.press('Control+Enter');
    expect(runtime.messagePosts).toBe(0);

    await editor.dispatchEvent('compositionend', { data: 'る' });
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await editor.press('Enter');
    await expect(editor).toHaveValue('扉を調べる\n');
    expect(runtime.messagePosts).toBe(0);
    await expect(page.getByTestId('ai-table-composer')).toBeInViewport();

    const accessibility = await new AxeBuilder({ page }).include('[data-testid="ai-table-composer"]').analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test('keeps independent two-client drafts editable through shared turn and takeover changes', async ({ browser }) => {
    const { campaignId } = seed();
    const runtime: RuntimeFixture = {
      status: 'idle',
      state: 'running',
      messageBehavior: 'success',
      messagePosts: 0,
    };
    const dmContext = await browser.newContext({ storageState: stateFor('dm'), serviceWorkers: 'block' });
    const playerContext = await browser.newContext({ storageState: stateFor('player'), serviceWorkers: 'block' });
    const dmPage = await dmContext.newPage();
    const playerPage = await playerContext.newPage();
    await installTableFixture(dmPage, [campaignId], runtime);
    await installTableFixture(playerPage, [campaignId], runtime);
    await Promise.all([dmPage.goto(`/c/${campaignId}/table`), playerPage.goto(`/c/${campaignId}/table`)]);
    await Promise.all([waitForStreams(dmPage), waitForStreams(playerPage)]);

    const dmEditor = dmPage.getByRole('textbox', { name: 'Your action' });
    const playerEditor = playerPage.getByRole('textbox', { name: 'Your action' });
    await dmEditor.fill('DM client draft');
    await playerEditor.fill('Player client draft');

    runtime.status = 'running';
    await Promise.all([
      emit(dmPage, campaignId, { type: 'turn.start' }),
      emit(playerPage, campaignId, { type: 'turn.start' }),
    ]);
    await expect(dmPage.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(playerPage.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(dmEditor).toBeEnabled();
    await expect(playerEditor).toBeEnabled();

    runtime.status = 'paused';
    runtime.state = 'human_control';
    await Promise.all([
      emit(dmPage, campaignId, { type: 'turn.end', stopReason: 'takeover', steps: 1, tokensUsed: 1, budgetRemaining: 9_999 }),
      emit(playerPage, campaignId, { type: 'turn.end', stopReason: 'takeover', steps: 1, tokensUsed: 1, budgetRemaining: 9_999 }),
    ]);
    await Promise.all([
      emit(dmPage, campaignId, { type: 'takeover', action: 'granted', memberId: 'fixture-dm' }),
      emit(playerPage, campaignId, { type: 'takeover', action: 'granted', memberId: 'fixture-dm' }),
    ]);
    await expect(sendStatus(dmPage)).toContainText('human has the DM seat');
    await expect(sendStatus(playerPage)).toContainText('human has the DM seat');
    await expect(dmEditor).toHaveValue('DM client draft');
    await expect(playerEditor).toHaveValue('Player client draft');
    expect(runtime.messagePosts).toBe(0);

    runtime.status = 'idle';
    runtime.state = 'running';
    await Promise.all([
      emit(dmPage, campaignId, { type: 'state', state: 'running' }),
      emit(playerPage, campaignId, { type: 'state', state: 'running' }),
    ]);
    await expect(dmPage.getByRole('button', { name: 'Send' })).toBeEnabled();
    await expect(playerPage.getByRole('button', { name: 'Send' })).toBeEnabled();

    await Promise.all([dmContext.close(), playerContext.close()]);
  });
});
