/**
 * Visual geometry regression for the consolidated design system (issue #674).
 *
 * Asserts canonical card/control metrics on representative routes:
 * auth, hub, dashboard, detail, admin, and mobile. Uses computed styles —
 * not screenshots — so the suite stays deterministic in CI.
 */
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Campaign } from '@campfire/schema';
import { stateFor } from './seed';

const MOBILE = { width: 390, height: 844 };

async function json<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function firstCampaign(request: APIRequestContext): Promise<Campaign> {
  const campaigns = await json<Campaign[]>(await request.get('/api/v1/campaigns'), 'list campaigns');
  const campaign = campaigns[0];
  if (!campaign) throw new Error('seed must provide at least one campaign');
  return campaign;
}

async function cardMetrics(page: import('@playwright/test').Page, selector: string) {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  return el.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      paddingTop: parseFloat(style.paddingTop),
      borderRadius: parseFloat(style.borderTopLeftRadius),
    };
  });
}

test.describe('Design-system visual geometry (#674)', () => {
  test('auth login card uses comfortable density radius', async ({ page }) => {
    await page.goto('/login');
    const card = page.locator('.login-auth-card.card').first();
    await expect(card).toBeVisible();
    const radius = await card.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius));
    expect(radius).toBeGreaterThanOrEqual(8);
    expect(radius).toBeLessThanOrEqual(14);
  });

  test.describe('signed-in surfaces', () => {
    test.use({ storageState: stateFor('dm') });

    test('campaign hub tiles use compact card radius', async ({ page }) => {
      await page.goto('/');
      const tile = page.locator('section.cf-card.cf-density-compact').first();
      await expect(tile).toBeVisible();
      const { borderRadius } = await cardMetrics(page, 'section.cf-card.cf-density-compact');
      expect(borderRadius).toBe(8);
    });

    test('dashboard party card uses compact density', async ({ page, request }) => {
      const campaign = await firstCampaign(request);
      await page.goto(`/c/${campaign.id}`);
      const party = page.locator('section.cf-card', { has: page.getByText('Party', { exact: true }) });
      await expect(party).toBeVisible();
      const { paddingTop, borderRadius } = await cardMetrics(page, 'section.cf-card >> nth=0');
      expect(paddingTop).toBeGreaterThan(7);
      expect(paddingTop).toBeLessThan(12);
      expect(borderRadius).toBe(8);
    });

    test('quest detail page loads with consolidated card shell', async ({ page, request }) => {
      const campaign = await firstCampaign(request);
      const quests = await json<Array<{ id: number; title: string }>>(
        await request.get(`/api/v1/campaigns/${campaign.id}/quests`),
        'list quests',
      );
      const quest = quests[0];
      test.skip(!quest, 'seed must provide a quest');
      await page.goto(`/c/${campaign.id}/quests/${quest!.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
      const cardCount = await page.locator('.card, section.cf-card').count();
      expect(cardCount).toBeGreaterThan(0);
    });

    test('admin console cards use canonical cf-card shell', async ({ page }) => {
      await page.goto('/admin');
      const card = page.locator('section.cf-card').first();
      await expect(card).toBeVisible();
      const radius = await card.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius));
      expect(radius).toBeGreaterThanOrEqual(8);
    });

    test('mobile AI onboarding hint keeps default-density card', async ({ page, request }) => {
      await page.addInitScript(() => {
        try {
          for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith('cf.aiOnboarding.dismissed.')) localStorage.removeItem(key);
          }
        } catch {
          /* non-fatal */
        }
      });
      const campaign = await firstCampaign(request);
      await page.setViewportSize(MOBILE);
      await page.goto(`/c/${campaign.id}`);
      await json<unknown>(
        await request.put(`/api/v1/campaigns/${campaign.id}/ai-dm`, { data: { mode: 'off' } }),
        'force seat off',
      );
      const card = page.locator('section.cf-card.cf-density-default', {
        has: page.getByText('Try the AI Dungeon Master', { exact: true }),
      });
      await expect(card).toBeVisible();
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(MOBILE.width);
    });
  });
});
