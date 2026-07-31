import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * IMPORTANT — what these goldens can and cannot catch (issue #1694):
 *
 * Every screenshot in this file renders through `@page.emulateMedia({ media: 'print' })`,
 * and index.css's `@media print` block sets
 * `button, input, textarea, select, [role="button"] { display: none !important }`.
 * That means these two PNGs (character-sheet-print.png, session-recap-print.png)
 * structurally CANNOT catch a control, button, or density change — there are no controls
 * left in the DOM by the time the screenshot fires. A green run here after a button
 * geometry / `.cf-btn` / `.btn` / density change proves nothing about that change.
 *
 * For screen-mode control-surface coverage (toolbars, dialogs, card grids, the character
 * sheet's control column), see control-surface-goldens.spec.ts instead.
 */
const SHARED_TOKEN = 'cf_share_11111111111111111111111111111111111111111111';

async function mockPublicRecap(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      setupRequired: false,
      localLoginEnabled: true,
      signupEnabled: false,
      oidcEnabled: false,
      version: 'test',
    }),
  }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401 }));
  await page.route(`**/api/v1/shared/recaps/${SHARED_TOKEN}`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      campaignName: 'Print test campaign',
      sessionNumber: 9,
      title: 'A printable shared recap',
      playedAt: '2026-07-26',
      recap: '# A quiet recap\n\nThe party returned safely.',
    }),
  }));
}

async function expectPrintSurface(page: Page): Promise<void> {
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeHidden();
  const chrome = page.locator('.cf-print-chrome');
  await expect(chrome).not.toHaveCount(0);
  await expect.poll(() => chrome.evaluateAll(
    (elements) => elements.every((element) => getComputedStyle(element).display === 'none'),
  )).toBe(true);
  await expect(page.locator('.cf-tabbar')).toBeHidden();
  await expect(page.locator('.reading-surface')).toHaveCSS('color', 'rgb(0, 0, 0)');
}

test.describe('print layouts (#667)', () => {
  test('prints a character sheet without application chrome', async ({ browser }) => {
    // The seeded navigation sheet is player-owned; full sheets are owner/DM scoped.
    const context = await browser.newContext({ storageState: stateFor('player') });
    const page = await context.newPage();
    try {
      await page.goto(`/c/${seed().campaignId}/characters/${seed().navigation.characterId}`);
      await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeVisible();
      await expectPrintSurface(page);
      await expect(page.getByTestId('character-sheet-tabs')).toBeHidden();
      await expect(page.getByTestId('character-sheet-panel-play')).toBeVisible();
      await expect(page.getByTestId('character-sheet-panel-build')).toBeVisible();
      await expect(page.getByTestId('character-sheet-panel-build').getByText('Background', { exact: true }).first()).toBeVisible();
      // Owner-only interactive controls (issue #1761) are hidden in print view
      await expect(page.getByTestId('character-hp-editor')).toBeHidden();
      await expect(page.getByTestId('rest-controls')).toBeHidden();
      await expect(page.getByRole('button', { name: '✎ Edit sheet' })).toBeHidden();

      await expect(page.locator('.reading-surface')).toHaveScreenshot('character-sheet-print.png', {
        animations: 'disabled',
        maxDiffPixelRatio: 0.05,
      });

      // Print chrome must not hide document/feature asides by element name.
      await page.evaluate(() => {
        const aside = document.createElement('aside');
        aside.id = 'print-semantic-aside';
        aside.textContent = 'Printable supplementary notes';
        document.querySelector('main')?.append(aside);
      });
      await expect(page.locator('#print-semantic-aside')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('prints a session recap without its editing controls', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    try {
      const { campaignId, navigation } = seed();
      await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
      await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit recap' })).toBeVisible();
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Edit recap' })).toBeHidden();
      await expect(page.locator('[data-entity-type="session"]')).toHaveCSS('color', 'rgb(0, 0, 0)');
      await expect(page.locator('[data-entity-type="session"]').getByText('The party crossed the moon gate.')).toBeVisible();
      await expect(page.getByText('Attendance not recorded.')).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Linked encounters' })).toBeHidden();
      await expect(page.locator('[data-entity-type="session"]')).toHaveScreenshot('session-recap-print.png', {
        animations: 'disabled',
        maxDiffPixelRatio: 0.02,
      });

      await page.emulateMedia({ media: 'screen' });
      await page.getByRole('button', { name: 'Edit recap' }).click();
      await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toHaveCount(0);
      await page.emulateMedia({ media: 'print' });
      await expect(page.locator('.cf-print-editor')).toBeHidden();
      await expect(page.locator('.cf-print-only').getByText('The party crossed the moon gate.')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('prints a shared recap without dark-theme chrome', async ({ page }) => {
    await mockPublicRecap(page);
    await page.goto(`/share/${SHARED_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'A printable shared recap' })).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeHidden();
    await expect(page.locator('main')).toHaveCSS('color', 'rgb(0, 0, 0)');
  });

  test('prints NPC, quest, location and encounter reference surfaces', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    try {
      const { campaignId, navigation } = seed();
      for (const path of [
        `/c/${campaignId}/npcs/${navigation.npcId}`,
        `/c/${campaignId}/quests/${navigation.questId}`,
        `/c/${campaignId}/locations/${navigation.locationId}`,
      ]) {
        await page.goto(path);
        await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeVisible();
        await page.emulateMedia({ media: 'print' });
        await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeHidden();
        await expect.poll(() => page.locator('.cf-print-chrome').evaluateAll(
          (elements) => elements.every((element) => getComputedStyle(element).display === 'none'),
        )).toBe(true);
        await expect(page.locator('.cf-print-reference > .cf-print-only')).toBeVisible();
        await expect(page.locator('.cf-print-reference > .cf-print-columns')).toBeHidden();
        await page.emulateMedia({ media: 'screen' });
      }

      await page.goto(`/c/${campaignId}/encounters/${navigation.encounterId}`);
      await page.emulateMedia({ media: 'print' });
      const roster = page.locator('.cf-print-roster');
      await expect(roster).toBeVisible();
      await expect(roster).toContainText('Initiative / order');
      await expect(roster).toContainText('Current / max / temp HP');
      await expect(page.locator('.cf-print-only')).toHaveCSS('overflow', 'visible');
    } finally {
      await context.close();
    }
  });

  test('keeps DM secrets opt-in and page-local', async ({ browser }) => {
    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const dmPage = await dmContext.newPage();
    const { campaignId, navigation } = seed();
    const secret = 'PRINT-ONLY DM SECRET';
    let previousSecret = '';
    try {
      const existing = await dmPage.request.get(`/api/v1/npcs/${navigation.npcId}`);
      expect(existing.ok()).toBe(true);
      previousSecret = (await existing.json() as { dmSecret?: string }).dmSecret ?? '';
      const patch = await dmPage.request.patch(`/api/v1/npcs/${navigation.npcId}`, { data: { dmSecret: secret } });
      expect(patch.ok()).toBe(true);
      await dmPage.goto(`/c/${campaignId}/npcs/${navigation.npcId}`);
      await expect(dmPage.getByLabel('Include DM secrets')).toBeVisible();
      await dmPage.emulateMedia({ media: 'print' });
      await expect(dmPage.locator('.cf-print-only .cf-print-secret')).toBeHidden();
      await dmPage.emulateMedia({ media: 'screen' });
      await dmPage.getByLabel('Include DM secrets').check();
      await dmPage.emulateMedia({ media: 'print' });
      await expect(dmPage.locator('.cf-print-only .cf-print-secret')).toBeVisible();
      await dmPage.emulateMedia({ media: 'screen' });
      await dmPage.goto(`/c/${campaignId}/quests/${navigation.questId}`);
      await expect.poll(() => dmPage.evaluate(() => document.documentElement.classList.contains('cf-print-include-secrets'))).toBe(false);

      // Same route component reuse (NPC → NPC) must also require a fresh opt-in.
      const otherNpc = await dmPage.request.post(`/api/v1/campaigns/${campaignId}/npcs`, {
        data: {
          name: `Print secret neighbor ${Date.now()}`,
          role: 'Test double',
          body: 'Another printable NPC.',
        },
      });
      expect(otherNpc.ok()).toBe(true);
      const otherNpcId = (await otherNpc.json() as { id: number }).id;
      const secretPatch = await dmPage.request.patch(`/api/v1/npcs/${otherNpcId}`, {
        data: { dmSecret: 'NEIGHBOR DM SECRET' },
      });
      expect(secretPatch.ok()).toBe(true);
      try {
        await dmPage.goto(`/c/${campaignId}/npcs/${navigation.npcId}`);
        await dmPage.getByLabel('Include DM secrets').check();
        await expect.poll(() => dmPage.evaluate(() => document.documentElement.classList.contains('cf-print-include-secrets'))).toBe(true);
        await dmPage.goto(`/c/${campaignId}/npcs/${otherNpcId}`);
        await expect.poll(() => dmPage.evaluate(() => document.documentElement.classList.contains('cf-print-include-secrets'))).toBe(false);
        await expect(dmPage.getByLabel('Include DM secrets')).not.toBeChecked();
      } finally {
        await dmPage.request.delete(`/api/v1/npcs/${otherNpcId}`);
      }
    } finally {
      await dmPage.request.patch(`/api/v1/npcs/${navigation.npcId}`, { data: { dmSecret: previousSecret } });
      await dmContext.close();
    }

    const playerContext = await browser.newContext({ storageState: stateFor('viewer') });
    const playerPage = await playerContext.newPage();
    try {
      await playerPage.goto(`/c/${campaignId}/npcs/${navigation.npcId}`);
      await expect(playerPage.getByLabel('Include DM secrets')).toHaveCount(0);
      await expect(playerPage.getByText(secret)).toHaveCount(0);
    } finally {
      await playerContext.close();
    }
  });

  test('keeps encounter paper prep DM-only', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('viewer') });
    const page = await context.newPage();
    try {
      const { campaignId, navigation } = seed();
      await page.goto(`/c/${campaignId}/encounters/${navigation.encounterId}`);
      await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toHaveCount(0);
      await page.emulateMedia({ media: 'print' });
      await expect(page.locator('.cf-print-roster')).toHaveCount(0);
      await expect(page.locator('[aria-label="Encounter reference sheet"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
