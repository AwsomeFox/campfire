import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type ButtonStyle = {
  background: string;
  border: string;
  color: string;
  cursor: string;
  opacity: string;
  outline: string;
  transitionDuration: string;
};

function contrastRatio(foreground: string, background: string): number {
  const channels = (color: string) => {
    const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!values || values.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
    return values.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
  };
  const luminance = (color: string) => {
    const [red, green, blue] = channels(color);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

async function buttonStyle(button: Locator): Promise<ButtonStyle> {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      color: style.color,
      cursor: style.cursor,
      opacity: style.opacity,
      outline: style.outlineColor,
      transitionDuration: style.transitionDuration,
    };
  });
}

async function resolveToken(page: Page, token: string, property: 'backgroundColor' | 'color' = 'color') {
  return page.evaluate(({ tokenName, cssProperty }) => {
    const probe = document.createElement('span');
    probe.style[cssProperty] = tokenName.startsWith('--') ? `var(${tokenName})` : tokenName;
    document.body.append(probe);
    const resolved = getComputedStyle(probe)[cssProperty];
    probe.remove();
    return resolved;
  }, { tokenName: token, cssProperty: property });
}

async function expectSolidDefault(page: Page, button: Locator) {
  const style = await buttonStyle(button);
  expect(style.background).toBe(await resolveToken(page, '--color-danger-solid', 'backgroundColor'));
  expect(style.color).toBe(await resolveToken(page, '--color-danger-solid-foreground'));
  expect(style.border).toBe(await resolveToken(page, '--color-danger-border'));
  expect(contrastRatio(style.color, style.background)).toBeGreaterThanOrEqual(4.5);
}

async function expectGhostDefault(page: Page, button: Locator) {
  const style = await buttonStyle(button);
  expect(style.background).toBe('rgba(0, 0, 0, 0)');
  expect(style.color).toBe(await resolveToken(page, '--color-danger'));
  expect(style.border).toBe(await resolveToken(page, '--color-danger-border'));
}

async function overrideAccent(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement.style;
    for (const token of ['--color-accent', '--cf-accent', '--color-accent-2', '--cf-accent-2']) {
      root.setProperty(token, '#00ff00');
    }
  });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
] as const) {
  test.describe(`${viewport.name} destructive controls`, () => {
    test.use({
      storageState: stateFor('dm'),
      viewport: { width: viewport.width, height: viewport.height },
    });

    test('keeps solid page and dialog states semantic, keyboard-safe, and accessible', async ({ page }) => {
      const fixture = seed();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/c/${fixture.campaignId}/npcs/${fixture.npcId}`);

      await page.getByRole('button', { name: '✎ Edit' }).click();
      const trigger = page.getByRole('button', { name: 'Delete NPC' });
      const editor = trigger.locator('xpath=ancestor::section');
      const cancelEdit = editor.getByRole('button', { name: 'Cancel', exact: true });
      await expect(trigger).toHaveClass(/cf-btn-danger/);
      await expectSolidDefault(page, trigger);
      expect((await buttonStyle(trigger)).transitionDuration).toBe('0s');

      const beforeAccentOverride = await buttonStyle(trigger);
      await overrideAccent(page);
      expect(await buttonStyle(trigger)).toEqual(beforeAccentOverride);

      await trigger.hover();
      let interactiveStyle = await buttonStyle(trigger);
      expect(interactiveStyle.background).toBe(
        await resolveToken(page, '--color-danger-solid-hover', 'backgroundColor'),
      );
      expect(contrastRatio(interactiveStyle.color, interactiveStyle.background)).toBeGreaterThanOrEqual(4.5);
      await page.mouse.down();
      interactiveStyle = await buttonStyle(trigger);
      expect(interactiveStyle.background).toBe(
        await resolveToken(page, '--color-danger-solid-active', 'backgroundColor'),
      );
      expect(contrastRatio(interactiveStyle.color, interactiveStyle.background)).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
      await page.mouse.up();

      await cancelEdit.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(trigger).toBeFocused();
      expect((await buttonStyle(trigger)).outline).toBe(await resolveToken(page, '--color-danger-focus'));

      await trigger.evaluate((button: HTMLButtonElement) => { button.disabled = true; });
      await expect(trigger).toBeDisabled();
      const disabled = await buttonStyle(trigger);
      expect(disabled.background).toBe(await resolveToken(page, '--color-danger-disabled-background', 'backgroundColor'));
      expect(disabled.color).toBe(await resolveToken(page, '--color-danger-disabled-foreground'));
      expect(disabled.border).toBe(await resolveToken(page, '--color-danger-disabled-border'));
      expect(disabled.opacity).toBe('1');
      await trigger.evaluate((button: HTMLButtonElement) => { button.disabled = false; });

      let releaseDelete!: () => void;
      const deleteMayFinish = new Promise<void>((resolve) => { releaseDelete = resolve; });
      await page.route(`**/api/v1/npcs/${fixture.npcId}`, async (route) => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await deleteMayFinish;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"test hold"}}' });
      });

      await trigger.click();
      const dialog = page.getByRole('dialog', { name: `Delete Bram the Innkeeper?` });
      const cancel = dialog.getByRole('button', { name: 'Cancel' });
      const confirm = dialog.getByRole('button', { name: 'Delete NPC' });
      await expect(cancel).toBeFocused();
      await expectSolidDefault(page, confirm);
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      expect((await buttonStyle(confirm)).outline).toBe(await resolveToken(page, '--color-danger-focus'));
      await page.keyboard.press('Tab');
      await expect(cancel).toBeFocused();

      const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      expect(accessibilityScan.violations).toEqual([]);
      await test.info().attach(`danger-dialog-${viewport.name}`, {
        body: await dialog.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      });

      await confirm.click();
      // Issue #793: busy copy keeps the action + object (not generic "Working…").
      const busyConfirm = dialog.getByRole('button', { name: 'Deleting NPC…' });
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
      await expect(busyConfirm).toBeDisabled();
      await expect(busyConfirm).toHaveAttribute('aria-busy', 'true');
      const busy = await buttonStyle(busyConfirm);
      expect(busy.background).toBe(await resolveToken(page, '--color-danger-solid-busy', 'backgroundColor'));
      expect(busy.color).toBe(await resolveToken(page, '--color-danger-solid-foreground'));
      expect(busy.cursor).toBe('wait');
      expect(busy.opacity).toBe('1');

      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      releaseDelete();
      await expect(busyConfirm).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test('keeps ghost delete states semantic on a representative page action', async ({ page }) => {
      const fixture = seed();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/c/${fixture.campaignId}/timeline`);

      const event = page.locator(`[data-entity-type="timeline"][data-entity-id="${fixture.navigation.timelineId}"]`);
      await event.getByRole('button', { name: 'Edit' }).click();
      const cancel = event.getByRole('button', { name: 'Cancel' });
      const danger = event.getByRole('button', { name: 'Delete' });
      await expect(danger).toHaveClass(/cf-btn-danger/);
      await expect(danger).toHaveClass(/cf-btn-ghost/);
      await expectGhostDefault(page, danger);

      const beforeAccentOverride = await buttonStyle(danger);
      await overrideAccent(page);
      expect(await buttonStyle(danger)).toEqual(beforeAccentOverride);

      await danger.hover();
      let style = await buttonStyle(danger);
      expect(style.background).toBe(await resolveToken(page, '--color-danger-ghost-hover', 'backgroundColor'));
      expect(style.color).toBe(await resolveToken(page, '--color-danger-focus'));
      await page.mouse.down();
      expect((await buttonStyle(danger)).background).toBe(
        await resolveToken(page, '--color-danger-ghost-active', 'backgroundColor'),
      );
      await page.mouse.move(0, 0);
      await page.mouse.up();

      await cancel.focus();
      await page.keyboard.press('Tab');
      await expect(danger).toBeFocused();
      expect((await buttonStyle(danger)).outline).toBe(await resolveToken(page, '--color-danger-focus'));

      await danger.evaluate((button: HTMLButtonElement) => { button.disabled = true; });
      style = await buttonStyle(danger);
      expect(style.background).toBe('rgba(0, 0, 0, 0)');
      expect(style.color).toBe(await resolveToken(page, '--color-danger-disabled-foreground'));
      expect(style.border).toBe(await resolveToken(page, '--color-danger-disabled-border'));
      expect(style.opacity).toBe('1');
      await danger.evaluate((button: HTMLButtonElement) => { button.disabled = false; });

      let releaseDelete!: () => void;
      const deleteMayFinish = new Promise<void>((resolve) => { releaseDelete = resolve; });
      await page.route(`**/api/v1/timeline/${fixture.navigation.timelineId}`, async (route) => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await deleteMayFinish;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"test hold"}}' });
      });

      await danger.click();
      await expect(danger).toBeDisabled();
      await expect(danger).toHaveAttribute('aria-busy', 'true');
      style = await buttonStyle(danger);
      expect(style.background).toBe(await resolveToken(page, '--color-danger-ghost-busy', 'backgroundColor'));
      expect(style.color).toBe(await resolveToken(page, '--color-danger'));
      expect(style.cursor).toBe('wait');

      await test.info().attach(`danger-page-delete-${viewport.name}`, {
        body: await event.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      });
      releaseDelete();
      await expect(danger).not.toHaveAttribute('aria-busy', 'true');

      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await cancel.focus();
      await page.keyboard.press('Tab');
      await expect(danger).toBeFocused();
      const forcedColorStyle = await buttonStyle(danger);
      expect(await danger.evaluate((button) => getComputedStyle(button).forcedColorAdjust)).toBe('none');
      expect(forcedColorStyle.color).toBe(await resolveToken(page, 'Mark'));
      expect(forcedColorStyle.border).toBe(await resolveToken(page, 'Mark'));
      expect(forcedColorStyle.background).toBe(await resolveToken(page, 'Canvas', 'backgroundColor'));
      expect(forcedColorStyle.outline).toBe(await resolveToken(page, 'Highlight'));
    });
  });
}
