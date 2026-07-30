import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type CreatedArc = { id: number; title: string; sortOrder: number; beats?: CreatedBeat[] };
type CreatedBeat = { id: number; title: string; sortOrder: number; arcId: number };

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

async function listArcs(page: Page, campaignId: number): Promise<CreatedArc[]> {
  const response = await page.request.get(`/api/v1/campaigns/${campaignId}/arcs`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<CreatedArc[]>;
}

/** Document order of arc sections by id (issue #1312). */
async function arcSectionOrder(page: Page, arcIds: number[]): Promise<number[]> {
  return page.evaluate((ids) => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[id^="entity-arc-"]'));
    const positions = new Map(sections.map((el, index) => [el.id, index]));
    return ids.map((id) => positions.get(`entity-arc-${id}`) ?? -1);
  }, arcIds);
}

/** Document order of beat headings within an arc section. */
async function beatTitleOrder(page: Page, arcId: number, beatIds: number[]): Promise<number[]> {
  return page.evaluate(
    ({ arcId: aid, beatIds: bids }) => {
      const arc = document.getElementById(`entity-arc-${aid}`);
      if (!arc) return bids.map(() => -1);
      const beats = Array.from(arc.querySelectorAll<HTMLElement>('[id^="entity-beat-"]'));
      const positions = new Map(beats.map((el, index) => [el.id, index]));
      return bids.map((id) => positions.get(`entity-beat-${id}`) ?? -1);
    },
    { arcId, beatIds },
  );
}

function expectAscending(positions: number[]) {
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i - 1], `position ${i - 1} should precede ${i}`).toBeLessThan(positions[i]);
  }
}

test.describe('storylines reorder (issue #1312)', () => {
  test.use({ storageState: stateFor('dm') });

  test.afterEach(async ({ page }) => {
    while (createdArcIds.length > 0) {
      const id = createdArcIds.pop();
      if (id) {
        await page.request.delete(`/api/v1/arcs/${id}`).catch(() => undefined);
      }
    }
  });

  test('reorder arcs and beats persist after refresh and match API order', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();

    const arcAlpha = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: `Alpha ${suffix}` });
    const arcBeta = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: `Beta ${suffix}` });
    const arcGamma = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: `Gamma ${suffix}` });

    const beatOne = await create<CreatedBeat>(page, `/api/v1/arcs/${arcAlpha.id}/beats`, { title: `One ${suffix}` });
    const beatTwo = await create<CreatedBeat>(page, `/api/v1/arcs/${arcAlpha.id}/beats`, { title: `Two ${suffix}` });
    const beatThree = await create<CreatedBeat>(page, `/api/v1/arcs/${arcAlpha.id}/beats`, { title: `Three ${suffix}` });

    await page.goto(`/c/${campaignId}/storylines`);
    await expect(page.locator(`#entity-arc-${arcAlpha.id}`)).toBeVisible();
    await expect(page.locator(`#entity-arc-${arcBeta.id}`)).toBeVisible();
    await expect(page.locator(`#entity-arc-${arcGamma.id}`)).toBeVisible();

    const arcPositions = await arcSectionOrder(page, [arcAlpha.id, arcBeta.id, arcGamma.id]);
    expectAscending(arcPositions);

    const beatPositions = await beatTitleOrder(page, arcAlpha.id, [beatOne.id, beatTwo.id, beatThree.id]);
    expectAscending(beatPositions);

    const betaMoveUp = page.locator(`#entity-arc-${arcBeta.id}`).getByRole('button', {
      name: `Move Beta ${suffix} up`,
      exact: true,
    });
    await expect(betaMoveUp).toBeEnabled();
    await betaMoveUp.click();
    await expect(async () => {
      const positions = await arcSectionOrder(page, [arcBeta.id, arcAlpha.id, arcGamma.id]);
      expectAscending(positions);
    }).toPass();

    const twoMoveDown = page.locator(`#entity-arc-${arcAlpha.id}`).getByRole('button', {
      name: `Move Two ${suffix} down`,
      exact: true,
    });
    await twoMoveDown.click();
    await expect(async () => {
      const positions = await beatTitleOrder(page, arcAlpha.id, [beatOne.id, beatThree.id, beatTwo.id]);
      expectAscending(positions);
    }).toPass();

    await page.reload();
    await expect(page.locator(`#entity-arc-${arcAlpha.id}`)).toBeVisible();

    await expect(async () => {
      const positions = await arcSectionOrder(page, [arcBeta.id, arcAlpha.id, arcGamma.id]);
      expectAscending(positions);
    }).toPass();
    await expect(async () => {
      const positions = await beatTitleOrder(page, arcAlpha.id, [beatOne.id, beatThree.id, beatTwo.id]);
      expectAscending(positions);
    }).toPass();

    const arcs = await listArcs(page, campaignId);
    const reordered = arcs.filter((a) => [arcAlpha.id, arcBeta.id, arcGamma.id].includes(a.id));
    expect(reordered.map((a) => a.title)).toEqual([`Beta ${suffix}`, `Alpha ${suffix}`, `Gamma ${suffix}`]);

    const alphaArc = arcs.find((a) => a.id === arcAlpha.id);
    expect(alphaArc).toBeDefined();
    expect(alphaArc!.beats!.map((b) => b.title)).toEqual([`One ${suffix}`, `Three ${suffix}`, `Two ${suffix}`]);
  });

  test('reorder buttons are keyboard accessible', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();

    const first = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: `First ${suffix}` });
    const second = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: `Second ${suffix}` });

    await page.goto(`/c/${campaignId}/storylines`);

    const moveDown = page.locator(`#entity-arc-${first.id}`).getByRole('button', {
      name: `Move First ${suffix} down`,
      exact: true,
    });
    await moveDown.focus();
    await expect(moveDown).toBeFocused();
    await page.keyboard.press('Enter');

    const positions = await arcSectionOrder(page, [second.id, first.id]);
    expectAscending(positions);
  });
});
