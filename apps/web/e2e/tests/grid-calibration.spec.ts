/**
 * VTT grid calibration (issue #417) — persistence contract + human-readable controls.
 *
 * Covers:
 *  - schema/back-compat: a new encounter defaults to the pre-#417 top-left square grid;
 *  - the calibration fields (origin offset, independent cell height, rotation, opacity)
 *    round-trip through PATCH → GET and are DM-only;
 *  - the Grid & fog panel replaces the cryptic "cell %w" with labelled controls + help,
 *    drives calibration PATCHes numerically (the keyboard/numeric alternative to dragging),
 *    exposes a Reset, and the Calibrate tool shows draggable anchors.
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * A real, decodable 16:9 PNG (16x9, RGB, correct chunk CRCs).
 *
 * Deliberately NOT the shared `PNG_16_9` from ./seed: that buffer has a corrupt IHDR CRC and a
 * malformed IDAT header, which is invisible to the specs that hand it straight to
 * `route.fulfill` but makes the upload endpoint reject it 400 ("Input buffer has corrupt
 * header: pngload_buffer: invalid chunk checksum") because the server decodes uploads to
 * derive dimensions. This spec posts the bytes through the real attachment API, so they have
 * to survive a real decode. 16:9 matches the battle-map surface's aspect ratio, so the map
 * fills the surface and the calibration overlay's contained-rect maths has no letterboxing to
 * account for.
 */
const CALIBRATION_MAP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAA/klEQVR42gXBMQFAERRA0RdBAIMIRuOPYBBAhBfhBjCIYDSKYBBAhBdBhH+OiOCEIEThE7JQBRUQujCEJWzhCiY8QcTjPMETPZ8ne6pHPXi6Z3iWZ3uuxzzPI5JwiZCIiS+REzWhCRI9MRIrsRM3YYmXECm4QijEwlfIhVrQAoVeGIVV2IVbsMIriChOCUpUPiUrVVEFpStDWcpWrmLKU0QarhEasfE1cqM2tEGjN0ZjNXbjNqzxGiITNwmTOPkmeVInOmHSJ2OyJntyJzZ5E5GDO4RDPHyHfKgHPXDoh3FYh324Bzu8g4jhjGBE4zOyUQ01MLoxjGVs4xpmPOMHGqHKgaBDFtMAAAAASUVORK5CYII=',
  'base64',
);

interface EncounterResponse {
  id: number;
  gridSize: number | null;
  gridOffsetX: number;
  gridOffsetY: number;
  gridCellHeight: number | null;
  gridRotation: number;
  gridOpacity: number;
}

function encounterUrl(encounterId: number): string {
  return `/c/${seed().campaignId}/encounters/${encounterId}`;
}

async function createEncounter(page: Page, name: string): Promise<number> {
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
    data: { name, hidden: false },
  });
  expect(created.ok()).toBe(true);
  return ((await created.json()) as EncounterResponse).id;
}

async function readEncounter(page: Page, encounterId: number): Promise<EncounterResponse> {
  const res = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(res.ok()).toBe(true);
  return res.json() as Promise<EncounterResponse>;
}

test.describe('grid calibration — issue #417', () => {
  test.describe('persistence contract', () => {
    test.use({ storageState: stateFor('dm') });

    test('new encounters default to the pre-#417 top-left square grid', async ({ page }) => {
      const id = await createEncounter(page, 'Calibration defaults');
      const enc = await readEncounter(page, id);
      expect(enc.gridOffsetX).toBe(0);
      expect(enc.gridOffsetY).toBe(0);
      expect(enc.gridCellHeight).toBeNull();
      expect(enc.gridRotation).toBe(0);
      expect(enc.gridOpacity).toBeCloseTo(0.35, 5);
    });

    test('calibration fields round-trip through PATCH → GET', async ({ page }) => {
      const id = await createEncounter(page, 'Calibration round-trip');
      const patched = await page.request.patch(`/api/v1/encounters/${id}`, {
        data: {
          gridSize: 8,
          gridOffsetX: 3.5,
          gridOffsetY: -2.25,
          gridCellHeight: 11,
          gridRotation: 12.5,
          gridOpacity: 0.6,
        },
      });
      expect(patched.ok()).toBe(true);
      const enc = await readEncounter(page, id);
      expect(enc.gridOffsetX).toBeCloseTo(3.5, 5);
      expect(enc.gridOffsetY).toBeCloseTo(-2.25, 5);
      expect(enc.gridCellHeight).toBe(11);
      expect(enc.gridRotation).toBeCloseTo(12.5, 5);
      expect(enc.gridOpacity).toBeCloseTo(0.6, 5);

      // gridCellHeight: null restores square cells.
      const cleared = await page.request.patch(`/api/v1/encounters/${id}`, { data: { gridCellHeight: null } });
      expect(cleared.ok()).toBe(true);
      expect((await readEncounter(page, id)).gridCellHeight).toBeNull();
    });

    test('out-of-range calibration is rejected by validation', async ({ page }) => {
      const id = await createEncounter(page, 'Calibration bounds');
      const badRotation = await page.request.patch(`/api/v1/encounters/${id}`, { data: { gridRotation: 90 } });
      expect(badRotation.ok()).toBe(false);
      const badOpacity = await page.request.patch(`/api/v1/encounters/${id}`, { data: { gridOpacity: 2 } });
      expect(badOpacity.ok()).toBe(false);
    });
  });

  test.describe('DM-only', () => {
    // Declared at the TOP of the block so the player storage state actually applies to the
    // test below (a test.use placed after the test does not reliably scope to it) — the
    // forbidden PATCH must run as a player for this to prove DM-only enforcement.
    test.use({ storageState: stateFor('player') });

    test('a player cannot calibrate the grid', async ({ page, browser }) => {
      // Create + enable the grid as DM, then attempt the calibration PATCH as a player.
      const dm = await browser.newContext({ storageState: stateFor('dm') });
      const dmPage = await dm.newPage();
      const id = await createEncounter(dmPage, 'Calibration authz');
      await dmPage.request.patch(`/api/v1/encounters/${id}`, { data: { gridSize: 8 } });
      await dm.close();

      const forbidden = await page.request.patch(`/api/v1/encounters/${id}`, { data: { gridOffsetX: 10 } });
      expect(forbidden.ok()).toBe(false);
      expect([401, 403]).toContain(forbidden.status());
    });
  });

  test.describe('calibration controls', () => {
    test.use({ storageState: stateFor('dm') });

    async function openGridPanel(page: Page, name: string): Promise<number> {
      const id = await createEncounter(page, name);

      // The battle-map surface (and with it the Grid & fog controls) only renders once the
      // encounter actually carries a map, so give it a REAL committed attachment rather than
      // proxying the encounter GET to splice `mapAttachmentId` into the response (issue #1595).
      //
      // The proxy version installed a `page.route` that did a full `route.fetch()` round trip
      // and was never unrouted. RunSessionPage polls the encounter query on a 5s
      // `refetchInterval` and re-invalidates it after every calibration PATCH, so a refetch was
      // routinely still inside that handler when the test body finished; `route.fetch()` /
      // `apiResponse.json()` then rejected against the disposed context ("Response has been
      // disposed"). Because nothing awaited the handler the rejection was attributed to
      // whichever test the runner happened to be executing, not to the one that installed the
      // route. Seeding the real field removes the handler — and therefore the window — instead
      // of racing to close it.
      const { campaignId } = seed();
      const upload = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
        multipart: {
          kind: 'map',
          file: { name: 'calibration-map.png', mimeType: 'image/png', buffer: CALIBRATION_MAP_PNG },
        },
      });
      expect(upload.ok()).toBe(true);
      const mapAttachmentId = ((await upload.json()) as { id: number }).id;

      // One PATCH: enable the grid (so the calibration controls render) and attach the map.
      const enabled = await page.request.patch(`/api/v1/encounters/${id}`, {
        data: { gridSize: 8, mapAttachmentId },
      });
      expect(enabled.ok()).toBe(true);

      await page.goto(encounterUrl(id));
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await page.getByRole('button', { name: 'Grid & fog' }).click();
      return id;
    }

    test('the panel uses labelled controls with help, not the cryptic "cell %w"', async ({ page }) => {
      await openGridPanel(page, 'Calibration UI copy');
      const controls = page.getByTestId('grid-calibration-controls');
      await expect(controls).toBeVisible();
      // Human-readable, accessible controls replace the old "cell %w".
      await expect(page.getByLabel('Cell width (percent of map width)')).toBeVisible();
      await expect(page.getByLabel('Grid origin X offset (percent of map width)')).toBeVisible();
      await expect(page.getByLabel('Grid origin Y offset (percent of map width)')).toBeVisible();
      await expect(page.getByLabel('Cell height (percent of map width); blank for square')).toBeVisible();
      await expect(page.getByLabel('Grid rotation in degrees')).toBeVisible();
      await expect(page.getByLabel('Grid overlay opacity (percent)')).toBeVisible();
      await expect(controls).toContainText('Align the overlay to a map');
      await expect(page.getByText('cell %w')).toHaveCount(0);
    });

    test('numeric edits persist calibration (keyboard alternative to dragging)', async ({ page }) => {
      const patches: Array<Record<string, unknown>> = [];
      page.on('request', (req: Request) => {
        if (req.method() === 'PATCH' && /\/api\/v1\/encounters\/\d+$/.test(req.url())) {
          const body = req.postDataJSON() as Record<string, unknown> | null;
          if (body) patches.push(body);
        }
      });
      await openGridPanel(page, 'Calibration numeric');

      // Each labelled control drives a calibration PATCH — the numeric/keyboard alternative to
      // dragging the anchors. (Round-trip persistence is asserted in the persistence-contract
      // suite; here we only assert the UI emits the right mutations.)
      await page.getByLabel('Grid origin X offset (percent of map width)').fill('10');
      await page.getByLabel('Grid origin X offset (percent of map width)').blur();
      await expect.poll(() => patches.some((p) => p.gridOffsetX === 10)).toBe(true);

      await page.getByLabel('Grid rotation in degrees').fill('15');
      await page.getByLabel('Grid rotation in degrees').blur();
      await expect.poll(() => patches.some((p) => p.gridRotation === 15)).toBe(true);

      await page.getByLabel('Grid overlay opacity (percent)').fill('80');
      await page.getByLabel('Grid overlay opacity (percent)').blur();
      await expect.poll(() => patches.some((p) => p.gridOpacity === 0.8)).toBe(true);
    });

    test('Reset calibration returns to the square default', async ({ page }) => {
      const id = await openGridPanel(page, 'Calibration reset');
      await page.request.patch(`/api/v1/encounters/${id}`, {
        data: { gridOffsetX: 7, gridRotation: 9, gridCellHeight: 20, gridOpacity: 0.8 },
      });
      await page.reload();
      await page.getByRole('button', { name: 'Grid & fog' }).click();
      await page.getByTestId('grid-calibration-reset').click();
      await expect
        .poll(async () => readEncounter(page, id))
        .toMatchObject({ gridOffsetX: 0, gridOffsetY: 0, gridCellHeight: null, gridRotation: 0 });
      expect((await readEncounter(page, id)).gridOpacity).toBeCloseTo(0.35, 5);
    });

    test('the Calibrate tool shows draggable anchors', async ({ page }) => {
      await openGridPanel(page, 'Calibration anchors');
      await page.getByTestId('map-tool-calibrate').click();
      await expect(page.getByTestId('grid-calibrate-anchor-origin')).toBeVisible();
      await expect(page.getByTestId('grid-calibrate-anchor-cell')).toBeVisible();
    });
  });
});
