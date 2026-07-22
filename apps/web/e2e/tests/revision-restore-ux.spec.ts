import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { EntityRevision, Quest } from '@campfire/schema';
import { seed, stateFor } from './seed';

const RECOVERED_BODY = [
  '# The recovered crossing',
  '',
  'The party followed the lantern road and kept the old promise.',
  '',
  'FULL-SNAPSHOT-END',
].join('\n');

async function currentQuest(page: Page): Promise<Quest> {
  const { navigation } = seed();
  const response = await page.request.get(`/api/v1/quests/${navigation.questId}`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Quest>;
}

function revisionFixtures(currentBody: string): EntityRevision[] {
  const { campaignId, navigation } = seed();
  return [
    {
      id: 8844,
      campaignId,
      entityType: 'quest',
      entityId: navigation.questId,
      snapshot: {
        body: RECOVERED_BODY,
        legacy_note: 'Imported safely from an older Campfire revision.',
      },
      authorUserId: 'fixture-editor',
      authorName: 'Morgan Vale',
      createdAt: '2026-07-21T15:04:00.000Z',
    },
    {
      id: 8843,
      campaignId,
      entityType: 'quest',
      entityId: navigation.questId,
      snapshot: { body: currentBody },
      authorUserId: 'fixture-editor',
      authorName: 'Morgan Vale',
      createdAt: '2026-07-20T12:00:00.000Z',
    },
  ];
}

async function mockHistory(page: Page, revisions: EntityRevision[], loadFailures = 0) {
  const { navigation } = seed();
  let attempts = 0;
  await page.route(`**/api/v1/revisions/quest/${navigation.questId}`, async (route) => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (attempts <= loadFailures) {
      await route.fulfill({ status: 503, json: { message: 'Temporary history outage' } });
      return;
    }
    await route.fulfill({ status: 200, json: revisions });
  });
  return () => attempts;
}

async function openHistory(page: Page) {
  const trigger = page.getByRole('button', { name: 'Edit history' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return trigger;
}

test.describe('revision restore preview and confirmation', () => {
  test.use({ storageState: stateFor('dm') });

  test('inspects a full field-aware diff and confirms a successful restore with keyboard-safe cancellation', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const quest = await currentQuest(page);
    const revisions = revisionFixtures(quest.body);
    await mockHistory(page, revisions);

    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    const panelTrigger = await openHistory(page);
    await expect(page.getByRole('status')).toContainText('Loading revision history');
    await expect(page.getByText('Differs from current content').first()).toBeVisible();
    await expect(page.getByText('Matches current content')).toBeVisible();

    const previewTrigger = page.getByRole('button', { name: /Preview version .* by Morgan Vale/ }).first();
    await previewTrigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAccessibleName('Inspect historical version');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription(/Saved .* by Morgan Vale/);
    await expect(dialog.getByText('FULL-SNAPSHOT-END')).toBeVisible();

    const bodyDiff = dialog.getByRole('region', { name: 'Quest description' });
    await expect(bodyDiff.getByText('Changed', { exact: true })).toBeVisible();
    await expect(bodyDiff.getByText('Current', { exact: true })).toBeVisible();
    await expect(bodyDiff.getByText('Selected version', { exact: true })).toBeVisible();
    await expect(bodyDiff.getByRole('heading', { name: 'The recovered crossing' })).toBeVisible();

    const legacyDiff = dialog.getByRole('region', { name: 'Legacy note' });
    await expect(legacyDiff.getByText('Historical only')).toBeVisible();
    await expect(legacyDiff).toContainText(/shown for reference and is not changed by restore/i);
    await expect(legacyDiff.getByText('Not recorded in this version.')).toBeVisible();
    await expect(legacyDiff.getByText('Imported safely from an older Campfire revision.')).toBeVisible();

    const close = dialog.getByRole('button', { name: 'Close preview' });
    const startRestore = dialog.getByRole('button', { name: 'Restore this version' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(startRestore).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(previewTrigger).toBeFocused();

    await previewTrigger.press('Enter');
    await page.getByRole('button', { name: 'Restore this version' }).click();
    await expect(dialog).toHaveAccessibleName('Restore this version?');
    await expect(dialog).toContainText(/Morgan Vale/);
    await expect(dialog).toContainText(/creates a new revision/i);
    await expect(dialog).toContainText(/Nothing in the history is erased/i);
    await expect(dialog.getByRole('button', { name: 'Cancel restore' })).toBeFocused();

    let restoreRequests = 0;
    await page.route(`**/api/v1/revisions/quest/${navigation.questId}/*/restore`, async (route) => {
      restoreRequests += 1;
      await route.fulfill({ status: 201, json: { revisions } });
    });

    await dialog.getByRole('button', { name: 'Cancel restore' }).click();
    await expect(dialog).toHaveAccessibleName('Inspect historical version');
    expect(restoreRequests).toBe(0);

    let restored = false;
    await page.route(`**/api/v1/quests/${navigation.questId}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Quest;
      await route.fulfill({ response, json: restored ? { ...body, body: RECOVERED_BODY } : body });
    });
    await page.getByRole('button', { name: 'Restore this version' }).click();
    restored = true;
    await page.getByRole('button', { name: 'Restore version' }).click();

    await expect(dialog).toBeHidden();
    expect(restoreRequests).toBe(1);
    await expect(previewTrigger).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: /Restored the version/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The recovered crossing' })).toBeVisible();
    await expect(panelTrigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('recovers from history-load and restore failures without changing the current content', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const quest = await currentQuest(page);
    const revisions = revisionFixtures(quest.body);
    const historyAttempts = await mockHistory(page, revisions, 1);
    let restoreAttempts = 0;
    await page.route(`**/api/v1/revisions/quest/${navigation.questId}/*/restore`, async (route) => {
      restoreAttempts += 1;
      if (restoreAttempts === 1) {
        await route.fulfill({ status: 500, json: { message: 'Restore failed' } });
      } else {
        await route.fulfill({ status: 201, json: { revisions } });
      }
    });

    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    await openHistory(page);
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load revision history" })).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('Differs from current content').first()).toBeVisible();
    expect(historyAttempts()).toBe(2);

    await page.getByRole('button', { name: /Preview version .* by Morgan Vale/ }).first().click();
    await page.getByRole('button', { name: 'Restore this version' }).click();
    await page.getByRole('button', { name: 'Restore version' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText("Couldn't restore this version");
    await expect(page.getByText(quest.body)).toBeVisible();
    await dialog.getByRole('button', { name: 'Try restore again' }).click();
    await expect(dialog).toBeHidden();
    expect(restoreAttempts).toBe(2);
  });

  test('stacks the comparison and actions in a narrow mobile viewport', async ({ browser }) => {
    const { campaignId, navigation } = seed();
    const context = await browser.newContext({ storageState: stateFor('dm'), viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    const quest = await currentQuest(page);
    await mockHistory(page, revisionFixtures(quest.body));

    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    await openHistory(page);
    await page.getByRole('button', { name: /Preview version .* by Morgan Vale/ }).first().click();

    const dialog = page.getByRole('dialog');
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(360);
    expect(bounds!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

    const bodyDiff = dialog.getByRole('region', { name: 'Quest description' });
    const currentBounds = await bodyDiff.getByText('Current', { exact: true }).locator('..').boundingBox();
    const selectedBounds = await bodyDiff.getByText('Selected version', { exact: true }).locator('..').boundingBox();
    expect(currentBounds).not.toBeNull();
    expect(selectedBounds).not.toBeNull();
    expect(selectedBounds!.y).toBeGreaterThan(currentBounds!.y + currentBounds!.height - 1);
    const closeBounds = await dialog.getByRole('button', { name: 'Close preview' }).boundingBox();
    const restoreBounds = await dialog.getByRole('button', { name: 'Restore this version' }).boundingBox();
    expect(closeBounds).not.toBeNull();
    expect(restoreBounds).not.toBeNull();
    expect(closeBounds!.width).toBeGreaterThan(330);
    expect(closeBounds!.width).toBeLessThanOrEqual(bounds!.width);
    expect(Math.abs(closeBounds!.y - restoreBounds!.y)).toBeGreaterThan(closeBounds!.height);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await context.close();
  });
});
