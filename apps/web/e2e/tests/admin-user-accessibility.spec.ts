import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { stateFor } from './seed';

test.describe('admin user creation accessibility', () => {
  test.use({ storageState: stateFor('admin') });

  test('supports a labeled, keyboard-complete user creation journey', async ({ page }) => {
    await page.goto('/admin/users');

    const trigger = page.getByRole('button', { name: /New user/ });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'New user' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleDescription(/Create a Campfire account/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const username = dialog.getByRole('textbox', { name: 'Username' });
    const displayName = dialog.getByRole('textbox', { name: /Display name/ });
    const password = dialog.getByLabel('Temporary password');
    const role = dialog.getByRole('combobox', { name: 'Server role' });
    const cancel = dialog.getByRole('button', { name: 'Cancel creating user' });
    const create = dialog.getByRole('button', { name: 'Create user' });

    await expect(username).toBeFocused();
    await expect(username).toHaveAttribute('autocomplete', 'username');
    await expect(username).toHaveAccessibleDescription(/2–60 characters/);
    await expect(displayName).toHaveAttribute('autocomplete', 'name');
    await expect(displayName).toHaveAccessibleDescription(/Shown to other Campfire users/);
    await expect(password).toHaveAttribute('autocomplete', 'new-password');
    await expect(password).toHaveAccessibleDescription(/At least 8 characters/);
    await expect(role).toHaveAccessibleDescription(/Admins can manage/);
    await expect(dialog.getByRole('button', { name: 'Cancel creating user' })).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);

    await page.keyboard.press('Tab');
    await expect(displayName).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(role).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(create).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(username).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(create).toBeFocused();

    const accessibilityScan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await expect(username).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    await expect(username).toHaveAccessibleDescription(/Enter a username/);
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAccessibleDescription(/Enter a password/);
    await expect(username).toBeFocused();

    await username.fill('player');
    await displayName.fill('Existing Player');
    await password.fill('keyboard-user-password');
    await role.selectOption('user');
    await password.press('Enter');

    await expect(username).toHaveAttribute('aria-invalid', 'true');
    await expect(username).toHaveAccessibleDescription(/That username is already in use/);
    await expect(username).toBeFocused();
    await expect(dialog).toBeVisible();

    const uniqueUsername = `keyboard-user-${Date.now()}`;
    let uniqueCreateRequests = 0;
    await page.route('**/api/v1/users', async (route) => {
      const body = route.request().postDataJSON() as { username?: string } | null;
      if (body?.username === uniqueUsername) {
        uniqueCreateRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await route.continue();
    });
    await username.fill(uniqueUsername);
    await displayName.fill('Keyboard User');
    await password.fill('keyboard-user-password');
    await role.selectOption('user');
    await password.press('Enter');
    await password.press('Enter');

    await expect(dialog).toBeHidden();
    expect(uniqueCreateRequests).toBe(1);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('cell', { name: uniqueUsername })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Keyboard User' })).toBeVisible();
  });
});
