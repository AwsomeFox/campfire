import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe.serial('Session Zero participant-owned access support', () => {
  test('desktop keyboard flow keeps facilitator visibility separate from AI consent', async ({ browser }) => {
    const { campaignId } = seed();
    const playerContext = await browser.newContext({ storageState: stateFor('player') });
    const player = await playerContext.newPage();
    await player.goto(`/c/${campaignId}/session-zero`);

    const support = player.getByRole('textbox', { name: 'What would help you participate comfortably?' });
    await support.fill('DESKTOP_SUPPORT_877: pause briefly before asking for my action.');
    await expect(player.getByRole('radio', { name: /Facilitators only/ })).toBeChecked();
    const aiConsent = player.getByRole('checkbox', { name: /Allow Campfire AI features/ });
    await aiConsent.focus();
    await player.keyboard.press('Space');
    await expect(aiConsent).toBeChecked();

    const save = player.getByRole('button', { name: 'Save preference' });
    await save.focus();
    await player.keyboard.press('Enter');
    await expect(player.getByRole('status')).toContainText('saved');
    const playerAxe = await new AxeBuilder({ page: player }).include('main').analyze();
    expect(playerAxe.violations).toEqual([]);

    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const dm = await dmContext.newPage();
    await dm.goto(`/c/${campaignId}/session-zero`);
    await expect(dm.getByText('Facilitator prep / live summary')).toBeVisible();
    await expect(dm.getByText(/DESKTOP_SUPPORT_877/)).toBeVisible();

    const viewerContext = await browser.newContext({ storageState: stateFor('viewer') });
    const viewer = await viewerContext.newPage();
    await viewer.goto(`/c/${campaignId}/session-zero`);
    await expect(viewer.getByText(/DESKTOP_SUPPORT_877/)).toHaveCount(0);

    await player.getByRole('button', { name: 'Delete my submission' }).focus();
    await player.keyboard.press('Enter');
    await player.getByRole('button', { name: 'Confirm delete' }).focus();
    await player.keyboard.press('Enter');
    await expect(player.getByRole('status')).toContainText('deleted');

    await playerContext.close();
    await dmContext.close();
    await viewerContext.close();
  });

  test('mobile table-sharing flow is responsive, keyboard-operable, and axe-clean', async ({ browser }) => {
    const { campaignId } = seed();
    const context = await browser.newContext({
      storageState: stateFor('player'),
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    await page.goto(`/c/${campaignId}/session-zero`);

    await page.getByRole('textbox', { name: 'What would help you participate comfortably?' })
      .fill('MOBILE_TABLE_SUPPORT_877: use explicit turn cues.');
    const tableRadio = page.getByRole('radio', { name: /Entire table/ });
    await tableRadio.focus();
    await page.keyboard.press('Space');
    await expect(tableRadio).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Allow Campfire AI features/ })).not.toBeChecked();
    await page.getByRole('button', { name: 'Save preference' }).click();
    await expect(page.getByRole('status')).toContainText('saved');

    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    const axe = await new AxeBuilder({ page }).include('main').analyze();
    expect(axe.violations).toEqual([]);

    const viewerContext = await browser.newContext({
      storageState: stateFor('viewer'),
      viewport: { width: 375, height: 812 },
    });
    const viewer = await viewerContext.newPage();
    await viewer.goto(`/c/${campaignId}/session-zero`);
    await expect(viewer.getByText(/MOBILE_TABLE_SUPPORT_877/)).toBeVisible();
    const viewerAxe = await new AxeBuilder({ page: viewer }).include('main').analyze();
    expect(viewerAxe.violations).toEqual([]);

    await page.getByRole('button', { name: 'Delete my submission' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await viewer.reload();
    await expect(viewer.getByText(/MOBILE_TABLE_SUPPORT_877/)).toHaveCount(0);

    await viewerContext.close();
    await context.close();
  });
});
