import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { seed, stateFor } from './seed';

interface EncounterResponse {
  id: number;
  gridSize: number | null;
  gridScale: number | null;
  gridUnit: string | null;
}

function encounterUrl(encounterId: number): string {
  return `/c/${seed().campaignId}/encounters/${encounterId}`;
}

function isDefaultPatch(request: Request): boolean {
  if (request.method() !== 'PATCH') return false;
  const body = request.postDataJSON() as Record<string, unknown> | null;
  return body?.gridScale === 5 && body?.gridUnit === 'ft' && Object.keys(body).length === 2;
}

async function createGridEncounter(page: Page, name: string): Promise<number> {
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name } });
  expect(created.ok()).toBe(true);
  const encounter = (await created.json()) as EncounterResponse;
  const enabled = await page.request.patch(`/api/v1/encounters/${encounter.id}`, { data: { gridSize: 8 } });
  expect(enabled.ok()).toBe(true);
  return encounter.id;
}

async function readEncounter(page: Page, encounterId: number): Promise<EncounterResponse> {
  const response = await page.request.get(`/api/v1/encounters/${encounterId}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<EncounterResponse>;
}

async function meaningfulDefaultAuditCount(page: Page, encounterId: number): Promise<number> {
  const response = await page.request.get(`/api/v1/campaigns/${seed().campaignId}/audit?limit=500&action=encounter.update`);
  expect(response.ok()).toBe(true);
  const rows = (await response.json()) as Array<{ entityId: number | null; detail: string }>;
  return rows.filter((row) => row.entityId === encounterId && row.detail.includes('gridScale') && row.detail.includes('gridUnit')).length;
}

test.describe('battle-grid default normalization — issue #865', () => {
  test.use({ storageState: stateFor('dm') });

  test('Strict Mode, pending/settled, SSE and polling still dispatch one equivalent PATCH', async ({ page }) => {
    const { campaignId } = seed();
    const encounterId = await createGridEncounter(page, 'Grid normalization — pending');
    let defaultPatches = 0;
    let encounterGets = 0;
    let eventStreams = 0;
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    await page.route(`**/api/v1/campaigns/${campaignId}/events`, async (route) => {
      eventStreams += 1;
      await route.continue();
    });
    await page.route(`**/api/v1/encounters/${encounterId}`, async (route) => {
      const request = route.request();
      if (request.method() === 'GET') encounterGets += 1;
      if (isDefaultPatch(request)) {
        defaultPatches += 1;
        await patchGate;
      }
      await route.continue();
    });

    await page.goto(encounterUrl(encounterId));
    await expect(page.getByRole('heading', { name: 'Grid normalization — pending' })).toBeVisible();
    await expect.poll(() => eventStreams).toBeGreaterThan(0);
    await expect.poll(() => defaultPatches).toBe(1);

    // While the default write is pending, a separate write emits encounter.updated. The
    // resulting SSE refetch returns the still-missing server fields, but must not enqueue a
    // duplicate equivalent mutation.
    const getsBeforeSse = encounterGets;
    const renamed = await page.request.patch(`/api/v1/encounters/${encounterId}`, {
      data: { name: 'Grid normalization — pending (SSE)' },
    });
    expect(renamed.ok()).toBe(true);
    await expect.poll(() => encounterGets, { timeout: 3_000 }).toBeGreaterThan(getsBeforeSse);
    expect(defaultPatches).toBe(1);

    // The five-second poll is the dropped-SSE backstop. It also sees missing server fields
    // while the PATCH is gated, and must still leave exactly one request pending.
    const getsBeforePoll = encounterGets;
    await expect.poll(() => encounterGets, { timeout: 7_000 }).toBeGreaterThan(getsBeforePoll);
    expect(defaultPatches).toBe(1);

    releasePatch();
    await expect
      .poll(async () => readEncounter(page, encounterId))
      .toMatchObject({ gridSize: 8, gridScale: 5, gridUnit: 'ft' });
    await page.waitForTimeout(750);
    expect(defaultPatches).toBe(1);
    expect(await meaningfulDefaultAuditCount(page, encounterId)).toBe(1);
  });

  test('a failed default PATCH retries only after fresh server truth arrives', async ({ page }) => {
    const encounterId = await createGridEncounter(page, 'Grid normalization — retry');
    let attempts = 0;

    await page.route(`**/api/v1/encounters/${encounterId}`, async (route) => {
      if (!isDefaultPatch(route.request())) {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Injected grid-default failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(encounterUrl(encounterId));
    await expect(page.getByRole('heading', { name: 'Grid normalization — retry' })).toBeVisible();
    await expect.poll(() => attempts).toBe(1);
    await page.waitForTimeout(500);
    expect(attempts).toBe(1);

    // The first failure leaves cached intent in place, avoiding a render-driven retry loop.
    // A later poll supplies the authoritative missing fields and permits exactly one retry.
    await expect.poll(() => attempts, { timeout: 7_000 }).toBe(2);
    await expect
      .poll(async () => readEncounter(page, encounterId))
      .toMatchObject({ gridSize: 8, gridScale: 5, gridUnit: 'ft' });
    expect(await meaningfulDefaultAuditCount(page, encounterId)).toBe(1);
  });

  test('two DM clients produce exactly one meaningful default PATCH', async ({ page, browser }) => {
    const encounterId = await createGridEncounter(page, 'Grid normalization — two clients');
    const secondContext = await browser.newContext({ storageState: stateFor('dm') });
    const secondPage = await secondContext.newPage();
    let outgoingPatches = 0;
    let releaseBoth!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const gateDefaultPatch = async (route: Route) => {
      if (!isDefaultPatch(route.request())) {
        await route.continue();
        return;
      }
      outgoingPatches += 1;
      if (outgoingPatches === 2) releaseBoth();
      await bothReady;
      await route.continue();
    };

    await page.route(`**/api/v1/encounters/${encounterId}`, gateDefaultPatch);
    await secondPage.route(`**/api/v1/encounters/${encounterId}`, gateDefaultPatch);

    try {
      await Promise.all([page.goto(encounterUrl(encounterId)), secondPage.goto(encounterUrl(encounterId))]);
      await expect(page.getByRole('heading', { name: 'Grid normalization — two clients' })).toBeVisible();
      await expect(secondPage.getByRole('heading', { name: 'Grid normalization — two clients' })).toBeVisible();
      await expect.poll(() => outgoingPatches).toBe(2);
      await expect
        .poll(async () => readEncounter(page, encounterId))
        .toMatchObject({ gridSize: 8, gridScale: 5, gridUnit: 'ft' });

      // Both clients intentionally reached the server from the same stale snapshot. The
      // atomic no-op check makes only one PATCH meaningful (one audit/SSE side effect).
      expect(await meaningfulDefaultAuditCount(page, encounterId)).toBe(1);
    } finally {
      releaseBoth();
      await secondContext.close();
    }
  });
});
