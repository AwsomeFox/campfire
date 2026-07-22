import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stateFor } from './seed';

type AiOverview = Record<string, unknown> & { allowedModels: string[] };

async function mockAllowlist(page: Page, initialAllowedModels: string[]) {
  let effectiveAllowedModels = [...initialAllowedModels];
  let overview: AiOverview = { allowedModels: effectiveAllowedModels };
  const requests: string[][] = [];

  await page.route(/\/api\/v1\/settings\/ai$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as AiOverview;
    overview = { ...body, allowedModels: effectiveAllowedModels };
    await route.fulfill({ response, json: overview });
  });

  await page.route(/\/api\/v1\/settings\/ai\/allowlist$/, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as { allowedModels: string[] };
    requests.push(body.allowedModels);
    effectiveAllowedModels = [...body.allowedModels];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...overview, allowedModels: effectiveAllowedModels }),
    });
  });

  return { requests };
}

test.describe('AI model allowlist editor accessibility', () => {
  test.use({ storageState: stateFor('admin') });

  test('names and describes the editor, normalizes supported separators, and saves by keyboard', async ({ page }) => {
    const { requests } = await mockAllowlist(page, []);
    await page.goto('/admin/ai');

    const editor = page.getByTestId('ai-model-allowlist');
    const textarea = editor.getByRole('textbox', { name: 'Allowed model IDs' });
    const save = editor.getByRole('button', { name: 'Save allowlist' });
    const effectiveState = editor.getByRole('status', { name: 'Effective allowlist state' });

    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveAccessibleName('Allowed model IDs');
    await expect(textarea).toHaveAccessibleDescription(
      'Separate model IDs with commas or line breaks. Leave blank to allow any model ID.',
    );
    await expect(textarea).toHaveAttribute('aria-invalid', 'false');
    await expect(effectiveState).toContainText('Unrestricted — any model ID is allowed.');

    await editor.getByText('Allowed model IDs', { exact: true }).click();
    await expect(textarea).toBeFocused();
    await textarea.fill('gpt-4o-mini\nclaude-3-5-haiku, gemini-2.5-pro');
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => requests).toEqual([['gpt-4o-mini', 'claude-3-5-haiku', 'gemini-2.5-pro']]);
    await expect(effectiveState).toContainText('Restricted to 3 model IDs.');

    await textarea.fill('  \n  ');
    await textarea.press('Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => requests).toEqual([
      ['gpt-4o-mini', 'claude-3-5-haiku', 'gemini-2.5-pro'],
      [],
    ]);
    await expect(effectiveState).toContainText('Unrestricted — any model ID is allowed.');

    const accessibilityScan = await new AxeBuilder({ page }).include('[data-testid="ai-model-allowlist"]').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('preserves invalid drafts, identifies duplicate and malformed entries, and reflows at 400% zoom', async ({
    page,
  }) => {
    // 320 CSS pixels is the WCAG reflow equivalent of a 1280px viewport at 400% browser zoom.
    await page.setViewportSize({ width: 320, height: 720 });
    const { requests } = await mockAllowlist(page, ['saved-model']);
    await page.goto('/admin/ai');

    const editor = page.getByTestId('ai-model-allowlist');
    const textarea = editor.getByRole('textbox', { name: 'Allowed model IDs' });
    const save = editor.getByRole('button', { name: 'Save allowlist' });
    const effectiveState = editor.getByRole('status', { name: 'Effective allowlist state' });

    const duplicateDraft = 'gpt-4o-mini\ngpt-4o-mini';
    await textarea.fill(duplicateDraft);
    const duplicateAlert = editor.getByRole('alert');
    await expect(duplicateAlert).toContainText('Entry 2 duplicates entry 1: “gpt-4o-mini”.');
    await expect(textarea).toHaveValue(duplicateDraft);
    await expect(textarea).toHaveAttribute('aria-invalid', 'true');
    await expect(textarea).toHaveAttribute('aria-errormessage', 'ai-allowed-model-ids-errors');
    await expect(textarea).toHaveAccessibleDescription(/Entry 2 duplicates entry 1/);
    await expect(save).toBeDisabled();
    await expect(effectiveState).toContainText('Restricted to 1 model ID.');
    expect(requests).toEqual([]);

    const malformedDraft = 'valid-model\nmodel with spaces';
    await textarea.fill(malformedDraft);
    await expect(editor.getByRole('alert')).toContainText(
      'Entry 2 contains whitespace. Separate model IDs with a comma or line break.',
    );
    await expect(textarea).toHaveValue(malformedDraft);

    const tooLong = `model-${'x'.repeat(115)}`;
    expect(tooLong).toHaveLength(121);
    await textarea.fill(tooLong);
    await expect(editor.getByRole('alert')).toContainText('Entry 1 is 121 characters; model IDs can be at most 120');
    await expect(textarea).toHaveValue(tooLong);
    await expect(save).toBeDisabled();

    const invalidAccessibilityScan = await new AxeBuilder({ page })
      .include('[data-testid="ai-model-allowlist"]')
      .analyze();
    expect(invalidAccessibilityScan.violations).toEqual([]);

    const longestValid = `model-${'x'.repeat(114)}`;
    expect(longestValid).toHaveLength(120);
    await textarea.fill(longestValid);
    await expect(editor.getByRole('alert')).toHaveCount(0);
    await expect(textarea).toHaveAttribute('aria-invalid', 'false');
    await textarea.press('Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => requests).toEqual([[longestValid]]);
    await expect(effectiveState).toContainText('Restricted to 1 model ID.');

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      page: document.documentElement.scrollWidth,
      editorClient: document.querySelector<HTMLElement>('[data-testid="ai-model-allowlist"]')?.clientWidth ?? 0,
      editorScroll: document.querySelector<HTMLElement>('[data-testid="ai-model-allowlist"]')?.scrollWidth ?? 0,
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.editorScroll).toBeLessThanOrEqual(overflow.editorClient);
  });
});
