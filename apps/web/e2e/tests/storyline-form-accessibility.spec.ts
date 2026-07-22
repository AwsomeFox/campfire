import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

type CreatedArc = { id: number; title: string };
type CreatedBeat = { id: number; title: string };
type CreatedBranch = { id: number; label: string };

async function create<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.ok(), `${path} should create its fixture`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function createArcWithBeat(page: Page, campaignId: number, arcTitle: string, beatTitle: string) {
  const arc = await create<CreatedArc>(page, `/api/v1/campaigns/${campaignId}/arcs`, { title: arcTitle });
  const beat = await create<CreatedBeat>(page, `/api/v1/arcs/${arc.id}/beats`, { title: beatTitle });
  return { arc, beat };
}

function politeAnnouncement(page: Page, message: string) {
  return page.locator('[aria-live="polite"]').filter({ hasText: message });
}

test.describe('storyline form component accessibility', () => {
  test.use({ storageState: stateFor('dm') });

  test('gives repeated forms stable contextual names, semantic branch fields, Enter submission, and spoken success', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const first = await createArcWithBeat(page, campaignId, `Ash Road ${suffix}`, `Cross the ford ${suffix}`);
    const second = await createArcWithBeat(page, campaignId, `Glass Road ${suffix}`, `Enter the ruins ${suffix}`);

    await page.goto(`/c/${campaignId}/storylines`);

    const newArc = page.getByRole('textbox', { name: 'New arc title' });
    const firstBeat = page.getByRole('textbox', { name: `New beat in ${first.arc.title}` });
    const secondBeat = page.getByRole('textbox', { name: `New beat in ${second.arc.title}` });
    await expect(newArc).toHaveAttribute('id', 'storyline-new-arc-title');
    await expect(firstBeat).toHaveAttribute('id', `storyline-new-beat-${first.arc.id}-title`);
    await expect(secondBeat).toHaveAttribute('id', `storyline-new-beat-${second.arc.id}-title`);
    await expect(page.getByRole('combobox', { name: `Status for arc ${first.arc.title}` })).toBeVisible();
    await expect(page.getByRole('combobox', { name: `Status for beat ${first.beat.title}` })).toBeVisible();

    const sourceBeat = page.locator(`#entity-beat-${first.beat.id}`);
    await sourceBeat.getByRole('button', { name: '+ Branch', exact: true }).click();
    const branchFields = sourceBeat.getByRole('group', { name: `New branch from ${first.beat.title}`, exact: true });
    const trigger = branchFields.getByRole('textbox', { name: 'Trigger' });
    const target = branchFields.getByRole('combobox', { name: 'Target beat' });
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('id', `storyline-new-branch-${first.beat.id}-trigger`);
    await expect(target).toHaveAttribute('id', `storyline-new-branch-${first.beat.id}-target`);
    await expect(target.locator(`option[value="${second.beat.id}"]`)).toHaveText(`${second.arc.title} · ${second.beat.title}`);

    await target.selectOption(String(second.beat.id));
    await trigger.fill('If the party follows the lanterns');
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/beats/${first.beat.id}/branches`) &&
      response.request().method() === 'POST' &&
      response.status() === 201,
    );
    await trigger.press('Enter');
    const created = await (await responsePromise).json() as CreatedBranch;

    const createdBranch = page.locator(`#storyline-branch-${created.id}`);
    await expect(createdBranch).toBeFocused();
    await expect(createdBranch).toHaveAccessibleName(`Branch ${created.label} from ${first.beat.title}`);
    await expect(politeAnnouncement(page, `Created branch ${created.label} from ${first.beat.title}.`)).toBeAttached();

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });

  test('preserves each failed form and its focus, then focuses and announces every created record', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const arcTitle = `Failure-safe arc ${suffix}`;
    const beatTitle = `Failure-safe beat ${suffix}`;
    const branchLabel = `Failure-safe branch ${suffix}`;
    let failArc = true;

    await page.route(`**/api/v1/campaigns/${campaignId}/arcs`, async (route) => {
      const request = route.request();
      const body = request.method() === 'POST' ? request.postDataJSON() as { title?: string } : undefined;
      if (failArc && body?.title === arcTitle) {
        failArc = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary arc failure' } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const arcInput = page.getByRole('textbox', { name: 'New arc title' });
    await arcInput.fill(arcTitle);
    await arcInput.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't create the arc" })).toBeVisible();
    await expect(arcInput).toHaveValue(arcTitle);
    await expect(arcInput).toBeFocused();
    await expect(arcInput).toHaveAttribute('aria-invalid', 'true');
    await expect(arcInput).toHaveAccessibleDescription(/title has been kept/i);

    const arcResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/campaigns/${campaignId}/arcs`) && response.request().method() === 'POST' && response.status() === 201,
    );
    await arcInput.press('Enter');
    const arc = await (await arcResponsePromise).json() as CreatedArc;
    await expect(page.locator(`#entity-arc-${arc.id}`)).toBeFocused();
    await expect(politeAnnouncement(page, `Created arc ${arc.title}.`)).toBeAttached();

    let failBeat = true;
    await page.route(`**/api/v1/arcs/${arc.id}/beats`, async (route) => {
      if (failBeat) {
        failBeat = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary beat failure' } });
        return;
      }
      await route.continue();
    });
    const beatInput = page.getByRole('textbox', { name: `New beat in ${arc.title}` });
    await beatInput.fill(beatTitle);
    await beatInput.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't create the beat" })).toBeVisible();
    await expect(beatInput).toHaveValue(beatTitle);
    await expect(beatInput).toBeFocused();
    await expect(beatInput).toHaveAccessibleDescription(/title has been kept/i);

    const beatResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/arcs/${arc.id}/beats`) && response.request().method() === 'POST' && response.status() === 201,
    );
    await beatInput.press('Enter');
    const beat = await (await beatResponsePromise).json() as CreatedBeat;
    const beatRecord = page.locator(`#entity-beat-${beat.id}`);
    await expect(beatRecord).toBeFocused();
    await expect(politeAnnouncement(page, `Created beat ${beat.title} in ${arc.title}.`)).toBeAttached();

    await beatRecord.getByRole('button', { name: '+ Branch', exact: true }).click();
    const branchFields = beatRecord.getByRole('group', { name: `New branch from ${beat.title}`, exact: true });
    const trigger = branchFields.getByRole('textbox', { name: 'Trigger' });
    const target = branchFields.getByRole('combobox', { name: 'Target beat' });
    const retainedTarget = String(seed().navigation.beatId);
    await target.selectOption(retainedTarget);

    let failBranch = true;
    await page.route(`**/api/v1/beats/${beat.id}/branches`, async (route) => {
      if (failBranch) {
        failBranch = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary branch failure' } });
        return;
      }
      await route.continue();
    });
    await trigger.fill(branchLabel);
    await trigger.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't create the branch" })).toBeVisible();
    await expect(trigger).toHaveValue(branchLabel);
    await expect(target).toHaveValue(retainedTarget);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleDescription(/trigger and target have been kept/i);

    const branchResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/beats/${beat.id}/branches`) && response.request().method() === 'POST' && response.status() === 201,
    );
    await trigger.press('Enter');
    const branch = await (await branchResponsePromise).json() as CreatedBranch;
    await expect(page.locator(`#storyline-branch-${branch.id}`)).toBeFocused();
    await expect(politeAnnouncement(page, `Created branch ${branch.label} from ${beat.title}.`)).toBeAttached();
  });

  test('reflows long contextual labels at the 400-percent zoom equivalent without horizontal scrolling', async ({ page }) => {
    const { campaignId } = seed();
    const arcTitle = `Long arc ${'unbroken-context-'.repeat(10)}`.slice(0, 196);
    const beatTitle = `Long beat ${'unbroken-detail-'.repeat(10)}`.slice(0, 196);
    const { arc, beat } = await createArcWithBeat(page, campaignId, arcTitle, beatTitle);

    // A 1280 CSS-pixel desktop viewport reduced to 320 CSS pixels is the WCAG
    // reflow equivalent of 400% browser zoom. DPR 4 keeps the rendered capture
    // at the corresponding physical-pixel density.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 720,
      deviceScaleFactor: 4,
      mobile: false,
    });
    await page.goto(`/c/${campaignId}/storylines`);

    const beatRecord = page.locator(`#entity-beat-${beat.id}`);
    await beatRecord.getByRole('button', { name: '+ Branch', exact: true }).click();
    const branchFields = beatRecord.getByRole('group', { name: `New branch from ${beat.title}`, exact: true });
    await expect(branchFields.getByRole('textbox', { name: 'Trigger' })).toBeVisible();
    await expect(branchFields.getByRole('combobox', { name: 'Target beat' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: `New beat in ${arc.title}` })).toBeVisible();

    const metrics = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      devicePixelRatio: window.devicePixelRatio,
    }));
    expect(metrics.viewportWidth).toBe(320);
    expect(metrics.devicePixelRatio).toBe(4);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    for (const control of [
      page.getByRole('textbox', { name: `New beat in ${arc.title}` }),
      branchFields.getByRole('textbox', { name: 'Trigger' }),
      branchFields.getByRole('combobox', { name: 'Target beat' }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }

    const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });
});
