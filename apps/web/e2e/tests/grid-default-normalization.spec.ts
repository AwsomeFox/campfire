import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { PNG_16_9, seed, stateFor } from './seed';

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

function isScaleOnlyDefaultPatch(request: Request): boolean {
  if (request.method() !== 'PATCH') return false;
  const body = request.postDataJSON() as Record<string, unknown> | null;
  return body?.gridScale === 5 && Object.keys(body).length === 1;
}

async function createGridEncounter(page: Page, name: string): Promise<number> {
  const { campaignId } = seed();
  const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, { data: { name, hidden: false } });
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

async function gridScaleFiveAuditCount(page: Page, encounterId: number): Promise<number> {
  const response = await page.request.get(`/api/v1/campaigns/${seed().campaignId}/audit?limit=500&action=encounter.update`);
  expect(response.ok()).toBe(true);
  const rows = (await response.json()) as Array<{ entityId: number | null; detail: string }>;
  return rows.filter((row) => row.entityId === encounterId && row.detail.includes('"gridScale":5')).length;
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

  test('a deduped default attempt retries after the non-default request owning the pending key fails', async ({ page }) => {
    const { campaignId } = seed();
    const encounterId = await createGridEncounter(page, 'Grid normalization — deduped retry');

    // The `scale` field this test drives lives inside the Grid & fog panel, which only exists
    // once the encounter renders a battle-map surface — and that is gated purely on
    // `mapAttachmentId != null` being present in the encounter read. So give the encounter a
    // REAL committed map attachment instead of intercepting the encounter GET to splice the
    // field in (issue #1608 — the same defect #1595 fixed in grid-calibration).
    //
    // The interception installed a `page.route` that did a full `route.fetch()` upstream round
    // trip on every encounter GET and was never unrouted. RunSessionPage polls that query on a
    // 5s `refetchInterval` and re-invalidates it after every mutation, and this test drives
    // several (the gated default PATCH, the scale edit, the clearing PATCH), so a refetch was
    // routinely still inside the handler when the test body finished. `route.fetch()` /
    // `apiResponse.json()` then rejected against the disposed context ("Response has been
    // disposed" / "route.fetch: Test ended."). Nothing awaited the handler, so the rejection
    // landed on whichever test the runner was executing at that moment rather than on this
    // one — which is why it read as infra noise. Seeding the real field removes the handler,
    // and with it the window, rather than racing to close it faster with an unroute.
    const upload = await page.request.post(`/api/v1/campaigns/${campaignId}/attachments`, {
      multipart: {
        kind: 'map',
        file: { name: 'grid-default-map.png', mimeType: 'image/png', buffer: PNG_16_9 },
      },
    });
    expect(upload.ok()).toBe(true);
    const mapAttachmentId = ((await upload.json()) as { id: number }).id;

    // One PATCH: the non-default grid config this test starts from, plus the map. Attaching the
    // map here rather than in a second PATCH keeps the encounter.update audit trail — which
    // `gridScaleFiveAuditCount` reads below — the same shape it had under the interception.
    const configured = await page.request.patch(`/api/v1/encounters/${encounterId}`, {
      data: { gridScale: 10, gridUnit: 'ft', mapAttachmentId },
    });
    expect(configured.ok()).toBe(true);
    let attempts = 0;
    let releaseFirst!: () => void;
    const firstRequestHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // Everything that is not the scale-only default PATCH — including every encounter GET —
    // passes straight through with `route.continue()`. Unlike `route.fetch()`, continue hands
    // the request back to the browser without materialising an APIResponse the handler then
    // has to read, so there is nothing left holding a context-scoped object at teardown.
    await page.route(`**/api/v1/encounters/${encounterId}`, async (route) => {
      if (!isScaleOnlyDefaultPatch(route.request())) {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await firstRequestHeld;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Injected colliding grid-default failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(encounterUrl(encounterId));
    await expect(page.getByRole('heading', { name: 'Grid normalization — deduped retry' })).toBeVisible();
    await page.getByRole('button', { name: 'Grid & fog' }).click();
    await expect(page.getByLabel('scale')).toHaveValue('10');

    // A user-authored write owns the same pending patch key but does not own a default-attempt
    // marker. While it is held in flight, fresh server truth makes the field missing and causes
    // the normalization effect to dedupe against this request.
    await page.getByLabel('scale').fill('5');
    await expect.poll(() => attempts).toBe(1);
    const cleared = await page.request.patch(`/api/v1/encounters/${encounterId}`, { data: { gridScale: null } });
    expect(cleared.ok()).toBe(true);
    await expect.poll(async () => (await readEncounter(page, encounterId)).gridScale).toBeNull();
    releaseFirst();

    // A fresh authoritative read still sees the missing fields. The normalization effect must
    // be able to own a new attempt after the request that previously held the equivalent
    // pending key failed; a marker from the deduped effect may not suppress this retry.
    await expect.poll(() => attempts, { timeout: 7_000 }).toBe(2);
    await expect
      .poll(async () => readEncounter(page, encounterId))
      .toMatchObject({ gridSize: 8, gridScale: 5, gridUnit: 'ft' });
    expect(await gridScaleFiveAuditCount(page, encounterId)).toBe(1);
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
