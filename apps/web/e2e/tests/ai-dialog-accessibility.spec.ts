import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('AI drafting accessibility', () => {
  test.use({ storageState: stateFor('dm') });

  test('names the prompt and quantity, traps focus, closes on Escape, and restores focus', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/npcs`);

    const trigger = page.getByRole('button', { name: 'Draft with AI' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Draft an NPC with AI' });
    const prompt = dialog.getByRole('textbox', { name: 'Describe the NPC you want to draft' });
    const close = dialog.getByRole('button', { name: 'Close AI drafting dialog' });
    const decrease = dialog.getByRole('button', { name: 'Decrease number of NPCs' });
    const increase = dialog.getByRole('button', { name: 'Increase number of NPCs' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    const submit = dialog.getByRole('button', { name: 'Draft 2 NPCs' });

    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription(/pending proposals.*Nothing touches canon/i);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAccessibleDescription(/shady fence with a soft spot for stray cats/i);
    await expect(dialog.getByRole('group', { name: 'Number of NPCs' })).toBeVisible();
    await expect(decrease).toBeDisabled();
    await expect(dialog.getByRole('status')).toHaveText('1 NPC');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => trigger.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
    await expect.poll(() => dialog.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);

    await increase.click();
    await expect(dialog.getByRole('status')).toHaveText('2 NPCs');
    await expect(decrease).toBeEnabled();
    await prompt.fill('A retired dragon hunter who now protects young monsters.');

    // DOM order starts at Close, but deliberate initial focus starts at the prompt.
    // Walk every enabled control and prove the shared dialog hook wraps both ends.
    await prompt.focus();
    await page.keyboard.press('Tab');
    await expect(decrease).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(increase).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(submit).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(prompt).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => trigger.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);
  });

  test('blocks every dismissal path only while a draft request is in flight', async ({ page }) => {
    const { campaignId } = seed();
    let releaseResponse: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });

    await page.route(`**/api/v1/campaigns/${campaignId}/ai-dm/draft`, async (route) => {
      markStarted?.();
      await new Promise<void>((resolve) => { releaseResponse = resolve; });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          proposalIds: [],
          proposals: [],
          tokensUsed: 1,
          tokenBudget: 10_000,
          budgetRemaining: 9_999,
          provider: 'mock',
          model: 'e2e',
        }),
      });
    });

    await page.goto(`/c/${campaignId}/npcs`);
    const trigger = page.getByRole('button', { name: 'Draft with AI' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Draft an NPC with AI' });
    await dialog.getByRole('textbox', { name: 'Describe the NPC you want to draft' }).fill('A patient archivist.');
    // Exercise the shared hook's container fallback rather than relying on this
    // dialog's own tabIndex. During the request every child control is disabled.
    await dialog.evaluate((element) => element.removeAttribute('tabindex'));
    await dialog.getByRole('button', { name: 'Draft NPC' }).click();
    await requestStarted;

    await expect(dialog).toHaveAttribute('aria-busy', 'true');
    await expect(dialog.getByRole('button', { name: 'Close AI drafting dialog' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await expect(
      dialog.locator(
        'button:enabled, a[href], input:enabled, select:enabled, textarea:enabled, [tabindex]:not([tabindex="-1"])',
      ),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Tab');
    await expect(dialog).toBeFocused();
    await expect(dialog).toHaveAttribute('tabindex', '-1');
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();

    releaseResponse?.();
    await expect(dialog.getByText('No proposals were filed.')).toBeVisible();
    await expect(dialog).not.toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('AI mode disclosure accessibility', () => {
  test.use({ storageState: stateFor('player') });

  test('controls a named, responsive popover with focus and complete dismissal behavior', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`/c/${campaignId}`);

    const trigger = page.getByRole('button', { name: 'An AI is co-DMing this campaign — what that means' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const controlledId = await trigger.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    const popover = page.getByRole('dialog', { name: 'AI Co-DM explanation' });
    await expect(popover).toBeVisible();
    await expect(popover).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(page.locator(`[id="${controlledId}"]`)).toHaveCount(1);
    await expect(popover.getByText('What the AI sees')).toBeVisible();

    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(11);
    expect(box!.x + box!.width).toBeLessThanOrEqual(349);
    expect(box!.y).toBeGreaterThanOrEqual(11);
    expect(box!.y + box!.height).toBeLessThanOrEqual(629);

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Force the disclosure against the lower viewport edge and verify collision
    // handling flips it above the trigger rather than clipping it off-screen.
    await trigger.evaluate((element) => {
      const wrapper = element.parentElement;
      if (!wrapper) return;
      wrapper.style.position = 'fixed';
      wrapper.style.left = '12px';
      wrapper.style.bottom = '4px';
      wrapper.style.zIndex = '60';
    });
    await trigger.click();
    await expect(popover).toHaveAttribute('data-placement', 'top');
    const triggerBox = await trigger.boundingBox();
    const flippedBox = await popover.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(flippedBox).not.toBeNull();
    expect(flippedBox!.y + flippedBox!.height).toBeLessThanOrEqual(triggerBox!.y);

    await page.getByRole('heading', { name: 'Cinderhaven' }).click();
    await expect(popover).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
