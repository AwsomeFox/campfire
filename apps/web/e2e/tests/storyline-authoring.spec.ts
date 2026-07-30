import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type CreatedArc = { id: number; title: string; summary?: string };
type CreatedBeat = { id: number; title: string; body?: string };

const createdArcIds: number[] = [];

async function create<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.ok(), `${path} should create its fixture`).toBeTruthy();
  const result = (await response.json()) as T;
  if (path.endsWith('/arcs') && (result as { id?: number }).id) {
    createdArcIds.push((result as { id: number }).id);
  }
  return result;
}

async function createArcWithBeat(page: Page, campaignId: number, arcTitle: string, beatTitle: string) {
  const arc = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: arcTitle });
  const beat = await create<CreatedBeat>(page, `/api/v1/arcs/${arc.id}/beats`, { title: beatTitle });
  return { arc, beat };
}

test.describe('storyline authoring (issue #856)', () => {
  test.use({ storageState: stateFor('dm') });

  test.afterEach(async ({ page }) => {
    while (createdArcIds.length > 0) {
      const id = createdArcIds.pop();
      if (id) {
        await page.request.delete(`/api/v1/arcs/${id}`).catch(() => undefined);
      }
    }
  });

  test('edits arc summary with preview, save, and cancel', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { arc } = await createArcWithBeat(page, campaignId, `Author arc ${suffix}`, `Author beat ${suffix}`);

    await page.goto(`/c/${campaignId}/storylines`);
    const arcSection = page.locator(`#entity-arc-${arc.id}`);
    await arcSection.getByRole('button', { name: `Edit arc ${arc.title}`, exact: true }).click();

    const summary = arcSection.getByLabel('Summary (markdown)');
    await summary.fill('**Bold** arc notes');
    await arcSection.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(arcSection.getByText('Bold', { exact: true })).toBeVisible();

    const saveResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/arcs/${arc.id}`) &&
      response.request().method() === 'PATCH' &&
      response.status() === 200,
    );
    await arcSection.getByRole('button', { name: 'Save', exact: true }).click();
    await saveResponse;
    await expect(arcSection.getByText('Bold', { exact: true })).toBeVisible();
    await expect(arcSection).toBeFocused();

    await arcSection.getByRole('button', { name: `Edit arc ${arc.title}`, exact: true }).click();
    await summary.fill('Discarded draft');
    await arcSection.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(arcSection.getByText('Discarded draft')).toHaveCount(0);
    await expect(arcSection.getByText('Bold', { exact: true })).toBeVisible();
  });

  test('edits beat body and surfaces save failures', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { arc, beat } = await createArcWithBeat(page, campaignId, `Beat author arc ${suffix}`, `Beat author ${suffix}`);

    await page.goto(`/c/${campaignId}/storylines`);
    const beatSection = page.locator(`#entity-beat-${beat.id}`);
    await beatSection.getByRole('button', { name: `Edit beat ${beat.title}`, exact: true }).click();
    const body = beatSection.getByLabel('Body (markdown)');
    await body.fill('Scene beats:\n- open the gate');

    await page.route(`**/api/v1/beats/${beat.id}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 503, json: { message: 'Temporary save failure' } });
        return;
      }
      await route.continue();
    });

    await beatSection.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save the beat" })).toBeVisible();
    await expect(body).toHaveValue('Scene beats:\n- open the gate');

    await page.unroute(`**/api/v1/beats/${beat.id}`);
    const saveResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/beats/${beat.id}`) &&
      response.request().method() === 'PATCH' &&
      response.status() === 200,
    );
    await beatSection.getByRole('button', { name: 'Save', exact: true }).click();
    await saveResponse;
    await expect(beatSection.getByText('open the gate')).toBeVisible();
    await expect(page.locator(`#entity-arc-${arc.id}`)).toBeVisible();
  });

  test('creates arc and beat with optional markdown prose', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const arcTitle = `Created prose arc ${suffix}`;
    const beatTitle = `Created prose beat ${suffix}`;

    await page.goto(`/c/${campaignId}/storylines`);
    await page.getByLabel('New arc title').fill(arcTitle);
    await page.getByLabel('Summary (optional)').fill('Arc **pitch**');
    const createArcResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/arcs`) &&
      response.request().method() === 'POST' &&
      response.status() === 201,
    );
    await page.getByRole('button', { name: '+ New arc', exact: true }).click();
    const createdArc = await (await createArcResponse).json() as CreatedArc;
    const arcSection = page.locator(`#entity-arc-${createdArc.id}`);

    await arcSection.getByLabel(`New beat in ${arcTitle}`).fill(beatTitle);
    await arcSection.getByLabel('Body (optional)').fill('Beat *notes*');
    await arcSection.getByRole('button', { name: '+ Beat', exact: true }).click();

    await expect(arcSection.getByText('Arc pitch')).toBeVisible();
    await expect(arcSection.getByText('Beat notes')).toBeVisible();
  });
});
