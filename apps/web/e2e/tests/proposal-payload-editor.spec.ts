import { expect, test, type Page, type Route } from '@playwright/test';
import type { Proposal } from '@campfire/schema';
import { seed, stateFor } from './seed';

/**
 * Schema-driven proposal payload editor (issue #769).
 *
 * The pure classification/validation/preview logic is covered by
 * `proposal-payload-form.unit.spec.ts` (no DOM). This suite exercises the actual
 * rendered editor: persistent labels, an error associated with (and focus moved to)
 * the invalid field, the normalized-result preview, the guided/advanced round-trip
 * that preserves the draft on a bad switch, draft survival across a failed network
 * submit, and keyboard operability of the whole approve/reject flow.
 */
function proposal(
  id: number,
  options: Partial<Proposal> & Pick<Proposal, 'action' | 'entityType'>,
): Proposal {
  const title = `Proposal ${id}`;
  return {
    id,
    campaignId: seed().campaignId,
    entityId: id,
    payload: { title },
    snapshot: null,
    baseUpdatedAt: null,
    baseSnapshotHash: null,
    proposer: 'Player',
    proposerUserId: '7',
    proposerToken: null,
    generationProvenance: null,
    status: 'pending',
    resolvedBy: '',
    note: '',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    ...options,
  };
}

interface MockProposalApi {
  pending: Proposal[];
  approveCalls: Array<{ id: number; body: unknown }>;
  approveStatus: number;
}

async function mockProposalApi(page: Page, pending: Proposal[]): Promise<MockProposalApi> {
  const state: MockProposalApi = { pending, approveCalls: [], approveStatus: 201 };

  await page.route('**/api/v1/campaigns/*/proposals?status=*', async (route: Route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(status === 'pending' ? state.pending : []),
    });
  });

  await page.route('**/api/v1/proposals/*/approve', async (route: Route) => {
    const id = Number(route.request().url().match(/proposals\/(\d+)\/approve/)?.[1]);
    const body = route.request().postDataJSON();
    state.approveCalls.push({ id, body });
    if (state.approveStatus >= 400) {
      await route.fulfill({
        status: state.approveStatus,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Simulated approve failure' }),
      });
      return;
    }
    state.pending = state.pending.filter((p) => p.id !== id);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  return state;
}

test.describe('proposal payload editor', () => {
  test.use({ storageState: stateFor('dm') });

  test('guided mode shows a persistent label/help per field and associates + focuses a validation error', async ({ page }) => {
    const { campaignId } = seed();
    // A `create` proposal is used here specifically because QuestCreate requires
    // `title` — QuestUpdate (a partial of it) makes every field optional, which
    // wouldn't exercise the "required field" error/focus path at all.
    await mockProposalApi(page, [
      proposal(501, { action: 'create', entityType: 'quest', payload: { title: 'Old title', reward: 'Gold' } }),
    ]);

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('button', { name: 'Edit payload' }).click();

    const titleField = page.getByLabel('Title', { exact: true });
    await expect(titleField).toBeVisible();
    await expect(titleField).toHaveValue('Old title');
    // Persistent help text, not a placeholder-only hint.
    await expect(page.getByText('Required. 1–200 characters.')).toBeVisible();

    await titleField.fill('');
    await page.getByRole('button', { name: 'Approve edited' }).click();

    const error = page.getByRole('alert').filter({ hasText: 'This field is required.' });
    await expect(error).toBeVisible();
    await expect(titleField).toBeFocused();
    // aria-describedby wires the input to its own error paragraph, not just to help text.
    const describedBy = await titleField.getAttribute('aria-describedby');
    const errorId = await error.getAttribute('id');
    expect(describedBy).toContain(errorId);
  });

  test('preview reports the normalized result and exactly the field that changed', async ({ page }) => {
    const { campaignId } = seed();
    await mockProposalApi(page, [
      proposal(502, { action: 'update', entityType: 'quest', payload: { title: 'Old title', reward: 'Gold' } }),
    ]);

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('button', { name: 'Edit payload' }).click();
    await expect(page.getByText('Preview: no changes from the current proposal.')).toBeVisible();

    await page.getByLabel('Title', { exact: true }).fill('New title');
    await expect(page.getByText('Preview — 1 changed field')).toBeVisible();
    await expect(page.getByText('Old title', { exact: true })).toBeVisible();
    await expect(page.getByText('→ New title')).toBeVisible();
    // Reward was untouched, so it must not appear in the changed-fields preview.
    await expect(page.getByText('→ Gold')).toHaveCount(0);
  });

  test('an invalid JSON switch back to guided mode is refused and the raw draft is preserved', async ({ page }) => {
    const { campaignId } = seed();
    await mockProposalApi(page, [
      proposal(503, { action: 'update', entityType: 'quest', payload: { title: 'Old title' } }),
    ]);

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('button', { name: 'Edit payload' }).click();
    await page.getByRole('button', { name: 'Advanced: edit raw JSON' }).click();

    const rawEditor = page.getByLabel('Raw JSON payload');
    await expect(rawEditor).toBeVisible();
    await expect(rawEditor).toHaveValue(/"title": "Old title"/);

    await rawEditor.fill('{ this is not json');
    await page.getByRole('button', { name: 'Back to guided editor' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Fix the JSON before switching to the guided editor.' })).toBeVisible();
    // Still in advanced mode with the broken text intact — nothing was silently discarded.
    await expect(rawEditor).toHaveValue('{ this is not json');
    await expect(page.getByRole('button', { name: 'Advanced: edit raw JSON' })).toHaveCount(0);
  });

  test('a failed approve preserves the edited draft instead of resetting it', async ({ page }) => {
    const { campaignId } = seed();
    const api = await mockProposalApi(page, [
      proposal(504, { action: 'update', entityType: 'quest', payload: { title: 'Old title' } }),
    ]);
    api.approveStatus = 500;

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('button', { name: 'Edit payload' }).click();
    const titleField = page.getByLabel('Title', { exact: true });
    await titleField.fill('Edited while offline');
    await page.getByRole('button', { name: 'Approve edited' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Simulated approve failure' })).toBeVisible();
    // The edit is still there — a network failure must not silently discard the draft.
    await expect(titleField).toHaveValue('Edited while offline');
    await expect.poll(() => api.approveCalls.length).toBe(1);
  });

  test('the whole edit/approve flow is keyboard operable', async ({ page }) => {
    const { campaignId } = seed();
    const api = await mockProposalApi(page, [
      proposal(505, { action: 'update', entityType: 'quest', payload: { title: 'Old title' } }),
    ]);

    await page.goto(`/c/${campaignId}/proposals`);
    const editButton = page.getByRole('button', { name: 'Edit payload' });
    await editButton.focus();
    await page.keyboard.press('Enter');

    const titleField = page.getByLabel('Title', { exact: true });
    await titleField.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Keyboard title');
    await expect(titleField).toHaveValue('Keyboard title');

    await page.getByRole('button', { name: 'Approve edited' }).focus();
    await page.keyboard.press('Enter');

    // Every other guided field on QuestUpdate was left untouched, so the normalized
    // payload also carries their as-typed/nullable-cleared values (`giverNpcId`/
    // `parentId` are nullable number fields with nothing typed in); `hidden` is NOT
    // among them — it stays omitted since it was absent from the original payload and
    // the checkbox was never touched (see the "omit != false" secrecy invariant test
    // in proposal-payload-form.unit.spec.ts).
    await expect.poll(() => api.approveCalls).toEqual([
      { id: 505, body: { payload: { title: 'Keyboard title', giverNpcId: null, parentId: null } } },
    ]);
  });
});
