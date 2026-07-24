import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * First-party map-generation wizard (issue #409): the missing human workflow over the
 * already-shipped generate/preview REST endpoints. Covers the full journey a DM takes —
 * discover the generator beside upload, PREVIEW a candidate map (without attaching or
 * revealing it), REROLL to a different one, USE it (atomic generate + attach + grid
 * alignment), then RELOAD and confirm the attached map persisted.
 *
 * Runs against the real backend: generation is deterministic + offline, so no mocking is
 * needed. Each test works on its own throwaway preparing encounter so it never disturbs
 * the shared seed fight.
 */

interface EncounterResponse {
  id: number;
  mapAttachmentId?: number | null;
  gridSize: number | null;
  gridScale: number | null;
  gridType: string | null;
}

async function createEncounter(page: Page, name: string): Promise<number> {
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name } });
  expect(created.ok()).toBe(true);
  return ((await created.json()) as EncounterResponse).id;
}

async function readEncounter(page: Page, encounterId: number): Promise<EncounterResponse> {
  const res = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(res.ok()).toBe(true);
  return res.json() as Promise<EncounterResponse>;
}

function encounterUrl(encounterId: number): string {
  return `/c/${seed().campaignId}/encounters/${encounterId}`;
}

async function countMapAttachments(page: Page): Promise<number> {
  const res = await page.request.get(`/api/v1/campaigns/${seed().campaignId}/attachments`);
  expect(res.ok()).toBe(true);
  const rows = (await res.json()) as Array<{ kind: string }>;
  return rows.filter((r) => r.kind === 'map').length;
}

test.describe('generate-map wizard — issue #409', () => {
  test.use({ storageState: stateFor('dm') });

  test('discover → preview → reroll → use → reload', async ({ page }) => {
    const encounterId = await createEncounter(page, 'Generated-map wizard e2e');
    const mapsBefore = await countMapAttachments(page);

    await page.goto(encounterUrl(encounterId));
    await expect(page.getByRole('heading', { name: 'Generated-map wizard e2e' })).toBeVisible();

    // Discoverable beside upload: the built-in generator toggle sits in the "Get a map" panel.
    const toggle = page.getByTestId('generate-map-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();

    const panel = page.getByTestId('generate-map-panel');
    await expect(panel).toBeVisible();

    // A preview renders on open — with alt text — and NO map is attached/persisted yet.
    const preview = page.getByTestId('generate-map-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('alt', /generated .* battle map/i);
    await expect.poll(() => countMapAttachments(page)).toBe(mapsBefore);
    // The encounter still has no map while previewing.
    expect((await readEncounter(page, encounterId)).mapAttachmentId ?? null).toBeNull();

    // Reveal + capture the reproducible seed, then reroll and confirm a different map + seed.
    await panel.getByRole('button', { name: /Advanced/ }).click();
    const seedInput = page.getByTestId('generate-map-seed');
    await expect(seedInput).toBeVisible();
    const firstSeed = await seedInput.inputValue();
    expect(firstSeed.length).toBeGreaterThan(0);

    await page.getByTestId('generate-map-regenerate').click();
    // Regenerate briefly blanks the seed before the new one lands — wait for a non-empty
    // seed that differs from the first, not merely "not the first" (which the blank matches).
    await expect
      .poll(async () => {
        const v = await seedInput.inputValue();
        return v.length > 0 && v !== firstSeed;
      })
      .toBe(true);
    const secondSeed = await seedInput.inputValue();
    // Still nothing persisted after a reroll (no orphan attachments / quota use).
    await expect.poll(() => countMapAttachments(page)).toBe(mapsBefore);

    // Use this map: atomic generate + attach + grid alignment in one operation.
    await page.getByTestId('generate-map-use').click();

    // The battle-map surface now renders the attached map, and post-attach guidance appears.
    await expect(page.getByTestId('battle-map-surface')).toBeVisible();
    await expect(page.getByTestId('map-attach-guidance')).toBeVisible();

    // Server truth: the encounter points at a hidden generated map with an aligned grid,
    // reproduced from the seed the DM previewed.
    const attached = await readEncounter(page, encounterId);
    expect(attached.mapAttachmentId).toBeTruthy();
    expect(attached.gridType).toBe('square');
    expect(attached.gridSize).toBeGreaterThan(0);
    // Exactly one new map attachment was persisted (only the committed "Use").
    expect(await countMapAttachments(page)).toBe(mapsBefore + 1);

    // Reload — the attached map survives.
    await page.reload();
    await expect(page.getByTestId('battle-map-surface')).toBeVisible();
    const afterReload = await readEncounter(page, encounterId);
    expect(afterReload.mapAttachmentId).toBe(attached.mapAttachmentId);

    // The generated map is hidden from the player Handouts card by default (#97/#259).
    const attachments = await page.request.get(`/api/v1/campaigns/${seed().campaignId}/attachments`);
    const row = ((await attachments.json()) as Array<{ id: number; hidden: boolean }>).find(
      (a) => a.id === attached.mapAttachmentId,
    );
    expect(row?.hidden).toBe(true);

    // The committed seed was surfaced (copyable) in the wizard — reproducibility of that
    // seed through the persisting endpoint is covered byte-for-byte by the server suite.
    expect(secondSeed.length).toBeGreaterThan(0);
  });

  test('cancel closes the wizard without attaching anything', async ({ page }) => {
    const encounterId = await createEncounter(page, 'Generated-map cancel e2e');
    const mapsBefore = await countMapAttachments(page);

    await page.goto(encounterUrl(encounterId));
    await page.getByTestId('generate-map-toggle').click();
    const panel = page.getByTestId('generate-map-panel');
    await expect(page.getByTestId('generate-map-preview')).toBeVisible();

    // Scope to the wizard — a preparing encounter also has a header "Cancel" (delete) button.
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toBeHidden();

    expect((await readEncounter(page, encounterId)).mapAttachmentId ?? null).toBeNull();
    expect(await countMapAttachments(page)).toBe(mapsBefore);
  });
});
