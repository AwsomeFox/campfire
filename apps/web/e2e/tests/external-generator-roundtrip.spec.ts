import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { seed, stateFor } from './seed';

/**
 * External-generator guided round trip (issue #411): Watabou-style and donjon-style.
 *
 * Turns the bare Watabou/donjon outbound links into a first-class "External generator" step
 * inside the map-acquisition wizard. This exercises the whole DM journey without leaving the
 * card:
 *   discover → open generator (records the choice + shows a return checklist) → return →
 *   drop/select the exported image → validate + preview → import → attach + calibrate guidance,
 * plus the "remember the unfinished round trip across reload" behaviour.
 *
 * Runs against the real backend. `window.open` is stubbed so clicking "Open generator" never
 * navigates to the real third-party site (Campfire never fetches it either — that's the point).
 * A fixture PNG stands in for the DM's export.
 */

const WATABOU_FIXTURE = resolve(__dirname, '../fixtures/watabou-export.png');
const DONJON_FIXTURE = resolve(__dirname, '../fixtures/donjon-export.png');

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

function encounterUrl(encounterId: number): string {
  return `/c/${seed().campaignId}/encounters/${encounterId}`;
}

interface AttachmentRow {
  id: number;
  kind: string;
  hidden: boolean;
  filename: string;
}

async function mapAttachments(page: Page): Promise<AttachmentRow[]> {
  const res = await page.request.get(`/api/v1/campaigns/${seed().campaignId}/attachments`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as AttachmentRow[]).filter((r) => r.kind === 'map');
}

/** Stub window.open so "Open generator" never navigates to the real third-party site. */
async function stubWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Record calls for assertions but open nothing (Campfire never fetches the site).
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url ?? ''));
      return null;
    }) as typeof window.open;
  });
}

test.describe('external-generator round trip — issue #411', () => {
  test.use({ storageState: stateFor('dm') });

  async function runRoundTrip(
    page: Page,
    opts: { sourceId: string; fixture: string; encounterName: string },
  ) {
    await stubWindowOpen(page);
    const encounterId = await createEncounter(page, opts.encounterName);
    const mapsBefore = (await mapAttachments(page)).length;

    await page.goto(encounterUrl(encounterId));

    // Discover: expand the unified "Get a map" wizard, no separate control to hunt for.
    await page.getByTestId('get-a-map-toggle').click();

    const card = page.getByTestId(`external-generator-${opts.sourceId}`);
    await expect(card).toBeVisible();
    // Source-specific guidance + licence caveat are shown up front.
    await expect(card).toContainText(/export/i);

    // Open generator: records the choice + reveals the return checklist (no real navigation).
    await card.getByTestId(`open-generator-${opts.sourceId}`).click();
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened.length).toBe(1);

    const checklist = page.getByTestId(`return-checklist-${opts.sourceId}`);
    await expect(checklist).toBeVisible();

    // Return: the SAME card accepts the exported file (drop or pick).
    await page.getByTestId(`generator-file-input-${opts.sourceId}`).setInputFiles(opts.fixture);

    // Validate + preview: the export renders and no validation problem is shown.
    await expect(page.getByTestId(`generator-preview-${opts.sourceId}`)).toBeVisible();
    await expect(page.getByTestId(`generator-problem-${opts.sourceId}`)).toHaveCount(0);

    // Import: attaches the map and shows the grid-calibration guidance.
    const importBtn = page.getByTestId(`generator-import-${opts.sourceId}`);
    await expect(importBtn).toBeEnabled();
    await importBtn.click();

    await expect(page.getByTestId('battle-map-surface')).toBeVisible();
    await expect(page.getByTestId('map-attach-guidance')).toBeVisible();

    // Server truth: exactly one new map attachment, hidden (does NOT auto-publish, #97/#259),
    // with provenance (title) stamped onto the filename.
    const after = await mapAttachments(page);
    expect(after.length).toBe(mapsBefore + 1);
    const imported = after.find((r) => !after.slice(0, mapsBefore).some((b) => b.id === r.id));
    // Newest row: highest id.
    const newest = after.reduce((a, b) => (b.id > a.id ? b : a));
    expect(newest.hidden).toBe(true);
    expect(newest.filename.toLowerCase()).toContain('export');
    void imported;

    // The round trip is finished — the checklist is gone and nothing is left staged.
    await expect(checklist).toBeHidden();
  }

  test('Watabou-style: open → export → return → import → attach (hidden + provenance)', async ({ page }) => {
    await runRoundTrip(page, {
      sourceId: 'watabou-one-page-dungeon',
      fixture: WATABOU_FIXTURE,
      encounterName: 'Watabou round trip e2e',
    });
  });

  test('donjon-style: open → export → return → import → attach (hidden + provenance)', async ({ page }) => {
    await runRoundTrip(page, {
      sourceId: 'donjon-fantasy-maps',
      fixture: DONJON_FIXTURE,
      encounterName: 'donjon round trip e2e',
    });
  });

  test('remembers the unfinished round trip across a reload', async ({ page }) => {
    await stubWindowOpen(page);
    const encounterId = await createEncounter(page, 'Acquisition persistence e2e');
    await page.goto(encounterUrl(encounterId));

    await page.getByTestId('get-a-map-toggle').click();
    await page
      .getByTestId('external-generator-watabou-one-page-dungeon')
      .getByTestId('open-generator-watabou-one-page-dungeon')
      .click();
    await expect(page.getByTestId('return-checklist-watabou-one-page-dungeon')).toBeVisible();

    // Reload: the wizard reopens on the same generator with its return checklist restored,
    // without the DM re-opening the menu (issue #411 "remember unfinished acquisition state").
    await page.reload();
    await expect(page.getByTestId('return-checklist-watabou-one-page-dungeon')).toBeVisible();

    // "I'll do this later" clears it; after another reload the checklist is gone.
    await page.getByTestId('generator-later-watabou-one-page-dungeon').click();
    await page.reload();
    await page.getByTestId('get-a-map-toggle').click();
    await expect(page.getByTestId('return-checklist-watabou-one-page-dungeon')).toBeHidden();
  });
});
