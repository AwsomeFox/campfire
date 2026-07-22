import { test, expect } from '@playwright/test';
import { stateFor } from './seed';

async function openRuleSystemStep(page: import('@playwright/test').Page) {
  await page.goto('/?newCampaign=1');
  await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();
  await page.getByLabel('Name').fill('Rules navigation test');
  await page.getByRole('button', { name: /Next: rule system/ }).click();
  await expect(page.getByText('No rule systems are installed on this server yet.')).toBeVisible();
}

test.describe('empty rule-system navigation', () => {
  test('server admins get the exact rules route and an accessible return to campaign setup', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('admin') });
    const page = await context.newPage();
    await openRuleSystemStep(page);

    const rulesLink = page.getByRole('link', { name: 'Server admin → Rule systems' });
    await expect(rulesLink).toHaveAttribute('href', '/admin/rules?returnTo=%2F%3FnewCampaign%3D1');
    await rulesLink.click();

    await expect(page).toHaveURL(/\/admin\/rules\?returnTo=/);
    await expect(page.getByRole('heading', { name: 'Rule packs' })).toBeVisible();
    await page.reload();
    const returnLink = page.getByRole('link', { name: 'Back to campaign setup' });
    await expect(returnLink).toBeVisible();
    await returnLink.click();
    await expect(page).toHaveURL(/\?newCampaign=1$/);
    await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();

    await context.close();
  });

  test('non-admin DMs get ask-an-admin guidance without an admin-console link', async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    await openRuleSystemStep(page);

    await expect(page.getByText('Ask a server admin to install a rule system', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Server admin → Rule systems' })).toHaveCount(0);

    await context.close();
  });

  test('non-admin deep links stay gated and unsafe return paths are ignored', async ({ browser }) => {
    const dmContext = await browser.newContext({ storageState: stateFor('dm') });
    const dmPage = await dmContext.newPage();
    await dmPage.goto('/admin/rules?returnTo=%2F%2Fevil.example');
    await expect(dmPage.getByText('Server admins only')).toBeVisible();
    await expect(dmPage.getByRole('heading', { name: 'Rule packs' })).toHaveCount(0);
    await expect(dmPage.getByRole('link', { name: /Back to campaign/ })).toHaveCount(0);
    await dmContext.close();

    const adminContext = await browser.newContext({ storageState: stateFor('admin') });
    const adminPage = await adminContext.newPage();
    await adminPage.goto('/admin/rules?returnTo=%2F%2Fevil.example');
    await expect(adminPage.getByRole('heading', { name: 'Rule packs' })).toBeVisible();
    await expect(adminPage.getByRole('link', { name: /Back to campaign/ })).toHaveCount(0);
    await adminContext.close();
  });
});
