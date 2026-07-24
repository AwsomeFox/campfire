import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Genuine AI map generation wizard (issue #410). Runs against the real backend with NO AI
 * provider configured, so generation routes HONESTLY to the first-party procedural renderer
 * — deterministic + offline, no mocking. Covers the DM journey: open the wizard beside "Get
 * a map", check cost/readiness before spending, generate candidates, and attach one (which
 * lands hidden). Also covers the moderation-block error path. A true "cancel mid-flight" is
 * not meaningfully testable offline (procedural generation is synchronous), so the cancel
 * lever is exercised at the service/API layer in the server suite instead.
 */

interface EncounterResponse {
  id: number;
  mapAttachmentId?: number | null;
}

async function createEncounter(page: Page, name: string): Promise<number> {
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name } });
  expect(created.ok()).toBe(true);
  return ((await created.json()) as EncounterResponse).id;
}

async function countMapAttachments(page: Page): Promise<number> {
  const res = await page.request.get(`/api/v1/campaigns/${seed().campaignId}/attachments`);
  expect(res.ok()).toBe(true);
  const rows = (await res.json()) as Array<{ kind: string }>;
  return rows.filter((r) => r.kind === 'map').length;
}

function encounterUrl(encounterId: number): string {
  return `/c/${seed().campaignId}/encounters/${encounterId}`;
}

test.describe('AI map wizard — issue #410', () => {
  test.use({ storageState: stateFor('dm') });

  test('open → check readiness → generate → attach (hidden)', async ({ page }) => {
    const encounterId = await createEncounter(page, 'AI-map wizard e2e');
    const mapsBefore = await countMapAttachments(page);

    await page.goto(encounterUrl(encounterId));
    await expect(page.getByRole('heading', { name: 'AI-map wizard e2e' })).toBeVisible();

    // The AI map affordance sits in the "Get a map" panel beside the procedural generator.
    const toggle = page.getByTestId('ai-map-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();

    const dialog = page.getByRole('dialog', { name: /Generate a map with AI/i });
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder(/fog-drowned crypt/i).fill('a flooded crypt with two corridors');

    // Cost / readiness before spending: text-only/no provider ⇒ procedural, grid likely.
    await dialog.getByRole('button', { name: /Check cost\/readiness/i }).click();
    await expect(page.getByTestId('ai-map-readiness')).toContainText(/procedural-blueprint/i);

    // Generate candidates (procedural, offline).
    await dialog.getByRole('button', { name: /^Generate/ }).click();
    const previews = page.getByTestId('ai-map-previews');
    await expect(previews).toBeVisible();
    // Honest provenance is shown on each candidate.
    await expect(previews).toContainText(/procedural renderer/i);

    // Attach the first candidate — persists exactly one hidden map attachment.
    await previews.getByRole('button', { name: /Attach/i }).first().click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => countMapAttachments(page)).toBe(mapsBefore + 1);
  });

  test('moderation blocks a disallowed prompt without persisting anything', async ({ page }) => {
    const encounterId = await createEncounter(page, 'AI-map moderation e2e');
    const mapsBefore = await countMapAttachments(page);

    await page.goto(encounterUrl(encounterId));
    await page.getByTestId('ai-map-toggle').click();
    const dialog = page.getByRole('dialog', { name: /Generate a map with AI/i });
    await dialog.getByPlaceholder(/fog-drowned crypt/i).fill('explicit sexual imagery of a child');
    await dialog.getByRole('button', { name: /^Generate/ }).click();

    // The blocked job surfaces an error and no candidates render.
    await expect(dialog).toContainText(/blocked|moderation/i);
    await expect(page.getByTestId('ai-map-previews')).toHaveCount(0);
    expect(await countMapAttachments(page)).toBe(mapsBefore);
  });
});
