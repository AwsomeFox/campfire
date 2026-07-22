import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

const TESTED_AT = '2026-07-22T12:34:56.000Z';
const DRAFT_KEY = 'pw-unsaved-provider-key-never-render-852';

test.describe('AI provider visible-draft connection test', () => {
  test.describe('server scope', () => {
    test.use({ storageState: stateFor('admin') });

    test('sends the visible draft, invalidates stale/in-flight results, and clears a result on save failure', async ({ page }) => {
      await page.request.delete('/api/v1/settings/ai-provider');

      const requestBodies: Array<Record<string, unknown>> = [];
      let holdNext = false;
      let releaseHeld: (() => void) | undefined;
      let markHeldStarted: (() => void) | undefined;
      const heldStarted = new Promise<void>((resolve) => { markHeldStarted = resolve; });

      await page.route('**/api/v1/settings/ai-provider/test', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        const body = route.request().postDataJSON() as Record<string, unknown> | null;
        expect(body).not.toBeNull();
        if (!body) throw new Error('Connection test POST did not carry a JSON draft.');
        requestBodies.push(body);
        if (holdNext) {
          holdNext = false;
          markHeldStarted?.();
          await new Promise<void>((resolve) => { releaseHeld = resolve; });
        }
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            scope: 'server',
            testedTarget: 'server-default',
            providerType: body.providerType,
            model: body.model,
            baseUrl: body.baseUrl || null,
            credentialSource: body.apiKey ? 'candidate' : 'none',
            testedAt: TESTED_AT,
            error: null,
          }),
        });
      });

      await page.goto('/admin/ai');
      await expect(page.getByRole('heading', { level: 1, name: 'AI console' })).toBeVisible();
      await page.getByLabel('Provider').selectOption('openai');
      await page.getByLabel('Model', { exact: true }).fill('visible-unsaved-model');
      await page.getByLabel('Base URL (optional)').fill('https://visible-unsaved.example/v1');
      await page.getByLabel(/API key/).fill(DRAFT_KEY);
      await page.getByRole('button', { name: 'Test connection' }).click();

      const result = page.getByRole('status', { name: 'Connection test result' });
      await expect(result).toContainText('Connection OK');
      await expect(result).toContainText('openai / visible-unsaved-model · https://visible-unsaved.example/v1');
      await expect(result).toContainText('Server default draft');
      await expect(result).toContainText('Unsaved candidate key');
      await expect(result.locator('time')).toHaveAttribute('datetime', TESTED_AT);
      expect(requestBodies[0]).toEqual({
        providerType: 'openai',
        model: 'visible-unsaved-model',
        baseUrl: 'https://visible-unsaved.example/v1',
        apiKey: DRAFT_KEY,
      });
      await expect(page.getByText(DRAFT_KEY)).toHaveCount(0);

      // Any edit invalidates the completed result immediately.
      await page.getByLabel('Model', { exact: true }).fill('edited-after-success');
      await expect(result).toHaveCount(0);

      // A response launched for an older fingerprint is discarded after an
      // in-flight edit, even if it eventually succeeds.
      holdNext = true;
      await page.getByRole('button', { name: 'Test connection' }).click();
      await heldStarted;
      await page.getByLabel('Model', { exact: true }).fill('edited-while-test-in-flight');
      releaseHeld?.();
      await expect.poll(() => requestBodies.length).toBe(2);
      await expect(result).toHaveCount(0);

      // Establish a fresh result, then prove a failed save still invalidates it
      // while preserving the user's unsaved fields/key for correction.
      await page.getByRole('button', { name: 'Test connection' }).click();
      await expect(result).toContainText('edited-while-test-in-flight');
      await page.route('**/api/v1/settings/ai-provider', async (route) => {
        if (route.request().method() === 'PUT') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Synthetic save failure' }),
          });
        } else {
          await route.continue();
        }
      });
      await page.getByRole('button', { name: 'Save provider' }).click();
      await expect(page.getByText('Synthetic save failure')).toBeVisible();
      await expect(result).toHaveCount(0);
      await expect(page.getByLabel('Model', { exact: true })).toHaveValue('edited-while-test-in-flight');
      await expect(page.getByLabel(/API key/)).toHaveValue(DRAFT_KEY);

      const accessibilityScan = await new AxeBuilder({ page }).include('[data-testid="ai-provider-form-server"]').analyze();
      expect(accessibilityScan.violations).toEqual([]);
    });
  });

  test.describe('campaign scope', () => {
    test.use({ storageState: stateFor('dm') });

    test('sends an explicit blank key and explains inherited server-default targeting accessibly', async ({ page }) => {
      const { campaignId } = seed();
      let requestBody: Record<string, unknown> | undefined;
      await page.route(`**/api/v1/campaigns/${campaignId}/ai-provider/test`, async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        const body = route.request().postDataJSON() as Record<string, unknown> | null;
        expect(body).not.toBeNull();
        if (!body) throw new Error('Campaign connection test POST did not carry a JSON draft.');
        requestBody = body;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            scope: 'campaign',
            testedTarget: 'inherited-server-default',
            providerType: 'openai',
            model: requestBody.model,
            baseUrl: 'https://server-owned.example/v1',
            credentialSource: 'server',
            testedAt: TESTED_AT,
            error: null,
          }),
        });
      });

      await page.goto(`/c/${campaignId}/settings`);
      await page.getByRole('button', { name: /Advanced: override provider for this campaign/ }).click();
      const form = page.getByTestId('ai-provider-form-campaign');
      await form.getByLabel('Provider', { exact: true }).selectOption('anthropic');
      await form.getByLabel('Model', { exact: true }).fill('visible-campaign-draft');
      await form.getByLabel('Base URL (optional)', { exact: true }).fill('https://campaign-controlled.example');
      await expect(form.getByLabel(/API key/)).toHaveValue('');
      await form.getByRole('button', { name: 'Test connection' }).click();

      expect(requestBody).toEqual({
        providerType: 'anthropic',
        model: 'visible-campaign-draft',
        baseUrl: 'https://campaign-controlled.example',
        apiKey: '',
      });
      const result = form.getByRole('status', { name: 'Connection test result' });
      await expect(result).toContainText('openai / visible-campaign-draft · https://server-owned.example/v1');
      await expect(result).toContainText('Campaign draft using the inherited server default');
      await expect(result).toContainText('Stored server-default credential');
      await expect(result).not.toContainText('campaign-controlled.example');

      const accessibilityScan = await new AxeBuilder({ page }).include('#ai-dm-provider').analyze();
      expect(accessibilityScan.violations).toEqual([]);
    });
  });
});
