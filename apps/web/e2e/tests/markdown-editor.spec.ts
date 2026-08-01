import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

test.describe('MarkdownEditor', () => {
  test('toggles tabs and preserves content', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/sessions`);
    await page.getByRole('button', { name: /^\+ Add recap$/ }).click();

    const editor = page.locator('.cf-markdown-editor').first();
    await expect(editor).toBeVisible();

    const writeTab = editor.getByRole('tab', { name: 'Write' });
    const previewTab = editor.getByRole('tab', { name: 'Preview' });

    const textarea = editor.getByRole('textbox', { name: /Recap/i });
    await textarea.fill('Hello world');

    await previewTab.click();
    await expect(editor.getByText('Hello world')).toBeVisible();
    await expect(textarea).not.toBeVisible();

    await writeTab.click();
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('Hello world');
  });

  test('applies formatting via toolbar', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/sessions`);
    await page.getByRole('button', { name: /^\+ Add recap$/ }).click();

    const editor = page.locator('.cf-markdown-editor').first();
    const textarea = editor.getByRole('textbox', { name: /Recap/i });
    
    await textarea.fill('test');
    
    await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 4));
    await editor.getByRole('button', { name: 'Bold' }).click();

    await expect(textarea).toHaveValue('**test**');
  });

  test('applies formatting via keyboard shortcuts', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/sessions`);
    await page.getByRole('button', { name: /^\+ Add recap$/ }).click();

    const editor = page.locator('.cf-markdown-editor').first();
    const textarea = editor.getByRole('textbox', { name: /Recap/i });
    
    await textarea.fill('test');
    
    await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 4));
    
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await textarea.press(`${modifier}+b`);

    await expect(textarea).toHaveValue('**test**');
  });
});
