import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { CREDS } from '../global-setup';
import { stateFor } from './seed';

/**
 * Issue #770 — Server user management: durable contextual labels on create and
 * repeated edit/reset controls, grouped by username, with visible password
 * requirements, failure preservation, and spoken success.
 */

function politeAnnouncement(page: Page, message: string) {
  return page.locator('[aria-live="polite"]').filter({ hasText: message });
}

async function createUser(page: Page, username: string, displayName: string) {
  const response = await page.request.post('/api/v1/users', {
    data: {
      username,
      password: 'labeled-edit-password-1',
      displayName,
      serverRole: 'user',
    },
  });
  expect(response.ok(), `create ${username}`).toBeTruthy();
  return response.json() as Promise<{ id: number; username: string; displayName: string }>;
}

test.describe('admin user edit and reset labels (issue #770)', () => {
  test.use({ storageState: stateFor('admin') });

  test.beforeEach(async ({ page }) => {
    await page.request
      .post('/api/v1/auth/login', {
        data: { username: CREDS.admin.username, password: CREDS.admin.password },
      })
      .catch(() => undefined);
  });

  test('groups repeated edit rows under username legends with associated labels', async ({ page }) => {
    const suffix = Date.now();
    const shortName = `edit-a-${suffix}`;
    const longName = `edit-long-${'n'.repeat(40)}-${suffix}`.slice(0, 60);
    const first = await createUser(page, shortName, 'Short Edit User');
    const second = await createUser(page, longName, 'Long Edit User');

    await page.goto('/admin/users');

    const editFirst = page.getByRole('button', { name: `Edit ${first.username}`, exact: true });
    const editSecond = page.getByRole('button', { name: `Edit ${second.username}`, exact: true });
    const resetFirst = page.getByRole('button', { name: `Reset password for ${first.username}`, exact: true });
    const resetSecond = page.getByRole('button', { name: `Reset password for ${second.username}`, exact: true });
    await expect(editFirst).toBeVisible();
    await expect(editSecond).toBeVisible();
    await expect(resetFirst).toBeVisible();
    await expect(resetSecond).toBeVisible();
    await expect(page.getByRole('button', { name: `Delete ${first.username}`, exact: true })).toBeVisible();

    await editFirst.click();
    const firstGroup = page.getByRole('group', { name: `Edit ${first.username}`, exact: true });
    await expect(firstGroup).toBeVisible();

    const displayName = firstGroup.getByRole('textbox', { name: `Display name for ${first.username}` });
    const role = firstGroup.getByRole('combobox', { name: `Server role for ${first.username}` });
    const disabled = firstGroup.getByRole('checkbox', { name: `Disabled for ${first.username}` });
    await expect(displayName).toBeFocused();
    await expect(displayName).toHaveAttribute('name', `displayName-${first.id}`);
    await expect(displayName).toHaveAttribute('autocomplete', 'nickname');
    await expect(role).toHaveAttribute('name', `serverRole-${first.id}`);
    await expect(disabled).toHaveAttribute('name', `disabled-${first.id}`);

    await firstGroup.locator(`label[for="${await displayName.getAttribute('id')}"]`).click();
    await expect(displayName).toBeFocused();
    await firstGroup.locator(`label[for="${await role.getAttribute('id')}"]`).click();
    await expect(role).toBeFocused();

    // Open a second row — both groups remain distinguishable by username.
    await editSecond.click();
    const secondGroup = page.getByRole('group', { name: `Edit ${second.username}`, exact: true });
    await expect(secondGroup).toBeVisible();
    await expect(page.getByRole('group', { name: `Edit ${first.username}`, exact: true })).toHaveCount(0);
    await expect(secondGroup.getByRole('textbox', { name: `Display name for ${second.username}` })).toBeFocused();

    const longLegend = secondGroup.getByText(`Edit ${second.username}`, { exact: true });
    await expect(longLegend).toBeVisible();
    const legendBox = await longLegend.boundingBox();
    const pageWidth = page.viewportSize()?.width ?? 1280;
    expect(legendBox).toBeTruthy();
    expect(legendBox!.width).toBeLessThanOrEqual(pageWidth);

    const accessibilityScan = await new AxeBuilder({ page })
      .include(`[data-testid="user-edit-${second.id}"]`)
      .analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('keeps password requirements visible, supports managers, preserves failure, and announces success', async ({
    page,
  }) => {
    const suffix = Date.now();
    const username = `reset-${suffix}`;
    const created = await createUser(page, username, 'Reset Target');

    await page.goto('/admin/users');
    await page.getByRole('button', { name: `Reset password for ${created.username}`, exact: true }).click();

    const group = page.getByRole('group', { name: `Reset password for ${created.username}`, exact: true });
    await expect(group).toBeVisible();
    const password = group.getByLabel(`New password for ${created.username}`);
    await expect(password).toBeFocused();
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveAttribute('name', `new-password-${created.id}`);
    await expect(password).toHaveAttribute('autocomplete', 'new-password');
    await expect(password).toHaveAccessibleDescription(/At least 8 characters/);

    await password.fill('short');
    await password.press('Enter');
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAccessibleDescription(/Password must be at least 8 characters/);
    await expect(password).toHaveValue('short');
    await expect(password).toBeFocused();

    let failOnce = true;
    await page.route(`**/api/v1/users/${created.id}/password`, async (route) => {
      if (failOnce) {
        failOnce = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary reset failure' } });
        return;
      }
      await route.continue();
    });

    await password.fill('secure-reset-password-1');
    await group.getByRole('button', { name: `Set password for ${created.username}` }).click();
    await expect(group.getByRole('alert')).toContainText(/Temporary reset failure/);
    await expect(password).toHaveValue('secure-reset-password-1');
    await expect(password).toBeFocused();

    await group.getByRole('button', { name: `Set password for ${created.username}` }).click();
    await expect(group.getByRole('status')).toContainText(/Password updated/);
    await expect(politeAnnouncement(page, `Password reset for ${created.username}.`)).toBeAttached();
  });

  test('preserves edit values on failure and announces a successful save', async ({ page }) => {
    const suffix = Date.now();
    const username = `save-${suffix}`;
    const created = await createUser(page, username, 'Save Target');

    await page.goto('/admin/users');
    await page.getByRole('button', { name: `Edit ${created.username}`, exact: true }).click();
    const group = page.getByRole('group', { name: `Edit ${created.username}`, exact: true });
    const displayName = group.getByRole('textbox', { name: `Display name for ${created.username}` });
    const role = group.getByRole('combobox', { name: `Server role for ${created.username}` });
    const disabled = group.getByRole('checkbox', { name: `Disabled for ${created.username}` });

    await displayName.fill('Kept Display Name');
    await role.selectOption('admin');
    await disabled.check();

    let failOnce = true;
    await page.route(`**/api/v1/users/${created.id}`, async (route) => {
      if (route.request().method() === 'PATCH' && failOnce) {
        failOnce = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary update failure' } });
        return;
      }
      await route.continue();
    });

    await group.getByRole('button', { name: `Save ${created.username}` }).click();
    await expect(group.getByRole('alert')).toContainText(/Temporary update failure/);
    await expect(displayName).toHaveValue('Kept Display Name');
    await expect(role).toHaveValue('admin');
    await expect(disabled).toBeChecked();
    await expect(displayName).toBeFocused();

    await group.getByRole('button', { name: `Save ${created.username}` }).click();
    await expect(group).toHaveCount(0);
    await expect(politeAnnouncement(page, `Updated user ${created.username}.`)).toBeAttached();
    await expect(page.getByRole('cell', { name: 'Kept Display Name' })).toBeVisible();
  });

  test('create dialog keeps named password-manager fields and announces success', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByRole('button', { name: /New user/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New user' });

    const username = dialog.getByRole('textbox', { name: 'Username' });
    const password = dialog.getByLabel('Temporary password');
    await expect(username).toHaveAttribute('name', 'username');
    await expect(password).toHaveAttribute('name', 'password');
    await expect(password).toHaveAttribute('autocomplete', 'new-password');
    await expect(dialog.getByRole('combobox', { name: 'Server role' })).toHaveAttribute('name', 'serverRole');

    // Seeded player must remain addressable so password managers see a distinct
    // create flow rather than colliding with the signed-in admin session.
    await expect(username).not.toHaveValue(CREDS.admin.username);

    const uniqueUsername = `announce-${Date.now()}`;
    await username.fill(uniqueUsername);
    await dialog.getByRole('textbox', { name: /Display name/ }).fill('Announced User');
    await password.fill('announce-user-password');
    await dialog.getByRole('button', { name: 'Create user' }).click();

    await expect(dialog).toBeHidden();
    await expect(politeAnnouncement(page, `Created user ${uniqueUsername}.`)).toBeAttached();
    await expect(page.getByRole('cell', { name: uniqueUsername, exact: true })).toBeVisible();
  });
});
