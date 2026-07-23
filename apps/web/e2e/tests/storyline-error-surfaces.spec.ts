import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #688: every Storylines mutation/option-load failure must surface visibly
 * and locally — never silently revert a control, never collapse a failed options
 * load into an empty list, never discard the author's input. The create-failure +
 * input-retention path is covered by storyline-form-accessibility.spec.ts; this
 * suite pins the remaining surfaces: status selects, deletes, link saves, branch
 * deletes, and the option-load degraded form.
 */

type CreatedArc = { id: number; title: string; status?: string };
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

test.describe('storylines error surfaces (issue #688)', () => {
  test.use({ storageState: stateFor('dm') });

  test('arc status failure surfaces an inline note and leaves the select on server truth', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { arc } = await createArcWithBeat(page, campaignId, `Status-fail arc ${suffix}`, `Status-fail beat ${suffix}`);

    await page.route(`**/api/v1/arcs/${arc.id}/status`, async (route) => {
      await route.fulfill({ status: 503, json: { message: 'Temporary status failure' } });
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const statusSelect = page.getByRole('combobox', { name: `Status for arc ${arc.title}` });
    await expect(statusSelect).toHaveValue('planned');

    // Attempt to advance the status; the server rejects it.
    await statusSelect.selectOption('active');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save the arc status" })).toBeVisible();
    // The select is controlled by server truth, which never changed — it snaps back.
    await expect(statusSelect).toHaveValue('planned');
    await expect(statusSelect).toHaveAttribute('aria-invalid', 'true');

    // Removing the blockade and re-selecting succeeds; the note clears.
    await page.unroute(`**/api/v1/arcs/${arc.id}/status`);
    await statusSelect.selectOption('active');
    await expect(statusSelect).toHaveValue('active');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save the arc status" })).toHaveCount(0);
  });

  test('beat status failure surfaces an inline note and leaves the select on server truth', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { beat } = await createArcWithBeat(page, campaignId, `Beat-status arc ${suffix}`, `Beat-status beat ${suffix}`);

    await page.route(`**/api/v1/beats/${beat.id}/status`, async (route) => {
      await route.fulfill({ status: 503, json: { message: 'Temporary status failure' } });
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const statusSelect = page.getByRole('combobox', { name: `Status for beat ${beat.title}` });
    await expect(statusSelect).toHaveValue('planned');

    await statusSelect.selectOption('done');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save the beat status" })).toBeVisible();
    await expect(statusSelect).toHaveValue('planned');
    await expect(statusSelect).toHaveAttribute('aria-invalid', 'true');
  });

  test('arc delete failure keeps the arc and offers a retry that succeeds', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { arc } = await createArcWithBeat(page, campaignId, `Delete-fail arc ${suffix}`, `Delete-fail beat ${suffix}`);

    let failDelete = true;
    page.on('dialog', (dialog) => dialog.accept().catch(() => undefined));
    await page.route(`**/api/v1/arcs/${arc.id}`, async (route) => {
      if (failDelete && route.request().method() === 'DELETE') {
        failDelete = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary delete failure' } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const arcCard = page.locator(`#entity-arc-${arc.id}`);
    await arcCard.getByRole('button', { name: `Delete arc ${arc.title}` }).click();

    const retryNote = page.getByRole('alert').filter({ hasText: "Couldn't delete the arc" });
    await expect(retryNote).toBeVisible();
    await expect(retryNote.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The arc is still on the page.
    await expect(arcCard).toBeVisible();

    // Retry: the route now continues, the delete succeeds, the card goes away.
    await retryNote.getByRole('button', { name: 'Retry' }).click();
    await expect(arcCard).toHaveCount(0);
  });

  test('beat delete failure keeps the beat and offers a retry that succeeds', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { beat } = await createArcWithBeat(page, campaignId, `Beat-del arc ${suffix}`, `Beat-del beat ${suffix}`);

    let failDelete = true;
    page.on('dialog', (dialog) => dialog.accept().catch(() => undefined));
    await page.route(`**/api/v1/beats/${beat.id}`, async (route) => {
      if (failDelete && route.request().method() === 'DELETE') {
        failDelete = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary delete failure' } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const beatRow = page.locator(`#entity-beat-${beat.id}`);
    await beatRow.getByRole('button', { name: `Delete beat ${beat.title}` }).click();

    const retryNote = page.getByRole('alert').filter({ hasText: "Couldn't delete the beat" });
    await expect(retryNote).toBeVisible();
    await expect(retryNote.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(beatRow).toBeVisible();

    await retryNote.getByRole('button', { name: 'Retry' }).click();
    await expect(beatRow).toHaveCount(0);
  });

  test('branch delete failure keeps the branch and offers a retry that succeeds', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { beat } = await createArcWithBeat(page, campaignId, `Branch-del arc ${suffix}`, `Branch-del beat ${suffix}`);
    const branch = await create<CreatedBranch>(
      page,
      `/api/v1/beats/${beat.id}/branches`,
      { label: `Branch-del ${suffix}`, toBeatId: seed().navigation.beatId },
    );

    let failDelete = true;
    await page.route(`**/api/v1/beats/${beat.id}/branches/${branch.id}`, async (route) => {
      if (failDelete && route.request().method() === 'DELETE') {
        failDelete = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary delete failure' } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const branchChip = page.locator(`#storyline-branch-${branch.id}`);
    await expect(branchChip).toBeVisible();

    await branchChip.getByRole('button', { name: `Delete branch ${branch.label} from ${beat.title}` }).click();
    const retryNote = branchChip.getByRole('alert').filter({ hasText: "Couldn't delete that branch" });
    await expect(retryNote).toBeVisible();
    await expect(retryNote.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(branchChip).toBeVisible();

    await retryNote.getByRole('button', { name: 'Retry' }).click();
    await expect(branchChip).toHaveCount(0);
  });

  test('link save failure surfaces a retry that re-sends the attempted link, then succeeds', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { beat } = await createArcWithBeat(page, campaignId, `Link-fail arc ${suffix}`, `Link-fail beat ${suffix}`);
    const questId = seed().navigation.questId;

    let failPatch = true;
    await page.route(`**/api/v1/beats/${beat.id}`, async (route) => {
      if (failPatch && route.request().method() === 'PATCH') {
        failPatch = false;
        await route.fulfill({ status: 503, json: { message: 'Temporary link failure' } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const beatRow = page.locator(`#entity-beat-${beat.id}`);
    await beatRow.getByRole('button', { name: 'Link to play' }).click();

    const questSelect = beatRow.getByRole('combobox', { name: `Linked quest for ${beat.title}` });
    await questSelect.selectOption(String(questId));

    const retryNote = page.getByRole('alert').filter({ hasText: "Couldn't save that link" });
    await expect(retryNote).toBeVisible();
    await expect(retryNote.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The select is controlled by server truth (beat.questId is still null), so it reverts.
    await expect(questSelect).toHaveValue('');

    // Retry re-sends the pending patch; the route now continues and the link commits.
    await retryNote.getByRole('button', { name: 'Retry' }).click();
    await expect(questSelect).toHaveValue(String(questId));
    await expect(retryNote).toHaveCount(0);
  });

  test('option-load failure degrades the link pickers and surfaces a retry without blocking the form', async ({ page }) => {
    const { campaignId } = seed();
    const suffix = Date.now();
    const { beat } = await createArcWithBeat(page, campaignId, `Options-fail arc ${suffix}`, `Options-fail beat ${suffix}`);

    // Fail every options list the beat link-pickers read. A single toggled handler per
    // list is more reliable than route/unroute across the retry boundary.
    let failOptions = true;
    for (const sub of ['sessions', 'quests', 'encounters'] as const) {
      await page.route(`**/api/v1/campaigns/${campaignId}/${sub}`, async (route) => {
        if (failOptions) {
          await route.fulfill({ status: 503, json: { message: 'Temporary options failure' } });
          return;
        }
        await route.continue();
      });
    }

    await page.goto(`/c/${campaignId}/storylines`);
    const beatRow = page.locator(`#entity-beat-${beat.id}`);
    await beatRow.getByRole('button', { name: 'Link to play' }).click();

    // The couldn't-load note appears and each picker shows a couldn't-load placeholder.
    const degradedNote = page.getByRole('alert').filter({ hasText: "Couldn't load some linking options" });
    await expect(degradedNote).toBeVisible();
    await expect(degradedNote.getByRole('button', { name: 'Retry' })).toBeVisible();

    const questSelect = beatRow.getByRole('combobox', { name: `Linked quest for ${beat.title}` });
    await expect(questSelect).toBeDisabled();
    // The disabled select's currently-selected option is the couldn't-load placeholder.
    const selectedQuestText = await questSelect.evaluate((sel) => (sel as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
    expect(selectedQuestText.trim()).toBe("— couldn't load quests —");

    // The rest of the form is still usable: a new arc can still be created (no link needed).
    const arcInput = page.getByRole('textbox', { name: 'New arc title' });
    await arcInput.fill(`Post-option-failure arc ${suffix}`);
    const arcResponse = page.waitForResponse((r) =>
      r.url().endsWith(`/api/v1/campaigns/${campaignId}/arcs`) && r.request().method() === 'POST' && r.status() === 201,
    );
    await arcInput.press('Enter');
    const newArc = await (await arcResponse).json() as CreatedArc;
    await expect(page.locator(`#entity-arc-${newArc.id}`)).toBeVisible();

    // Clearing the blockade and retrying loads the options; the pickers enable.
    failOptions = false;
    const retryResponse = page.waitForResponse((r) =>
      r.url().includes(`/api/v1/campaigns/${campaignId}/quests`) && r.request().method() === 'GET' && r.ok(),
    );
    await degradedNote.getByRole('button', { name: 'Retry' }).click();
    await retryResponse;
    await expect(questSelect).toBeEnabled();
    await expect(degradedNote).toHaveCount(0);
  });

  test('no failed mutation leaves an unhandled promise rejection', async ({ page }) => {
    // A safety net for the acceptance criterion: every failure path in the suite
    // must settle without bubbling an unhandled rejection to the page. We exercise
    // a representative mutation (arc status) and assert the console stays clean
    // of "unhandledrejection" / error events for our routes.
    const { campaignId } = seed();
    const suffix = Date.now();
    const { arc } = await createArcWithBeat(page, campaignId, `Rejection arc ${suffix}`, `Rejection beat ${suffix}`);

    const rejectionSeen: string[] = [];
    page.on('pageerror', (err) => rejectionSeen.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /unhandled|rejection/i.test(msg.text())) rejectionSeen.push(msg.text());
    });

    await page.route(`**/api/v1/arcs/${arc.id}/status`, async (route) => {
      await route.fulfill({ status: 503, json: { message: 'Temporary status failure' } });
    });

    await page.goto(`/c/${campaignId}/storylines`);
    const statusSelect = page.getByRole('combobox', { name: `Status for arc ${arc.title}` });
    await statusSelect.selectOption('resolved');
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save the arc status" })).toBeVisible();
    await expect(statusSelect).toHaveValue('planned');

    // Give any stray microtask a beat to surface; then assert none did.
    await page.waitForTimeout(250);
    expect(rejectionSeen).toEqual([]);
  });
});
