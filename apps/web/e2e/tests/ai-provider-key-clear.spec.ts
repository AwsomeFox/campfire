import { test, expect } from '@playwright/test';
import { stateFor } from './seed';

const STORED_KEY = 'e2e-openai-stored-key-never-render-4457';

test.describe('AI provider stored-key clearing', () => {
  test.use({ storageState: stateFor('admin') });

  test('confirms a secure clear, retains non-key settings, and reports environment readiness', async ({ page }) => {
    const put = await page.request.put('/api/v1/settings/ai-provider', {
      data: {
        providerType: 'openai',
        model: 'gpt-4.1-mini',
        baseUrl: 'https://openai-compatible.example/v1',
        params: { temperature: 0.4, maxTokens: 4096 },
        allowedModels: ['gpt-4.1-mini'],
        apiKey: STORED_KEY,
      },
    });
    expect(put.ok()).toBeTruthy();

    await page.route('**/api/v1/settings/ai-provider/test', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          scope: 'server',
          testedTarget: 'server-default',
          providerType: 'openai',
          model: 'gpt-4.1-mini',
          baseUrl: 'https://openai-compatible.example/v1',
          credentialSource: 'stored',
          testedAt: '2026-07-22T12:34:56.000Z',
          error: null,
        }),
      });
    });

    await page.goto('/admin/ai');
    await expect(page.getByRole('heading', { level: 1, name: 'AI console' })).toBeVisible();
    await expect(page.getByText('Credential: Stored encrypted key')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear stored key' })).toBeVisible();
    await expect(page.getByText(STORED_KEY)).toHaveCount(0);

    await page.getByRole('button', { name: 'Test connection' }).click();
    const testResult = page.getByRole('status', { name: 'Connection test result' });
    await expect(testResult).toContainText('Connection OK');

    await page.getByRole('button', { name: 'Clear stored key' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear stored API key?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/provider, model, base URL, parameters, and allowlist stay unchanged/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Clear stored key' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(testResult).toHaveCount(0);
    await expect(page.getByText('Credential: Environment credential')).toBeVisible();
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear stored key' })).toHaveCount(0);
    await expect(page.getByText(STORED_KEY)).toHaveCount(0);

    const get = await page.request.get('/api/v1/settings/ai-provider');
    expect(get.ok()).toBeTruthy();
    const view = await get.json();
    expect(view).toMatchObject({
      providerType: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://openai-compatible.example/v1',
      params: { temperature: 0.4, maxTokens: 4096 },
      allowedModels: ['gpt-4.1-mini'],
      configured: false,
      keyLast4: null,
      credentialSource: 'environment',
      ready: true,
    });
    expect(JSON.stringify(view)).not.toContain(STORED_KEY);

    const audit = await page.request.get('/api/v1/admin/audit');
    const entries = await audit.json();
    const clearEntry = entries.find((entry: { action: string }) => entry.action === 'ai-provider.key-clear');
    expect(clearEntry).toMatchObject({ detail: 'server' });
    expect(JSON.stringify(clearEntry)).not.toContain(STORED_KEY);

    const removalPreview = await page.request.get('/api/v1/settings/ai-provider/removal-impact');
    expect(removalPreview.ok()).toBeTruthy();
    const remove = await page.request.delete('/api/v1/settings/ai-provider', {
      data: { impactRevision: (await removalPreview.json()).impactRevision },
    });
    expect(remove.ok()).toBeTruthy();
  });
});
