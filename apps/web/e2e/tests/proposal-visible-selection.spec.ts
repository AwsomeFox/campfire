import { expect, test, type Page, type Route } from '@playwright/test';
import type { Proposal } from '@campfire/schema';
import { seed, stateFor } from './seed';

type BatchResult = { id: number; ok: boolean; status?: number; error?: string };

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
    proposer: 'Player',
    proposerUserId: '7',
    proposerToken: null,
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
  submissions: Array<{ action: 'approve' | 'reject'; ids: number[] }>;
  onBatch: (action: 'approve' | 'reject', ids: number[]) => BatchResult[];
}

async function mockProposalApi(page: Page, pending: Proposal[]): Promise<MockProposalApi> {
  const state: MockProposalApi = {
    pending,
    submissions: [],
    onBatch: (action, ids) => {
      state.pending = state.pending.filter((row) => !ids.includes(row.id));
      return ids.map((id) => ({ id, ok: true }));
    },
  };

  await page.route('**/api/v1/campaigns/*/proposals?status=*', async (route: Route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(status === 'pending' ? state.pending : []),
    });
  });

  await page.route('**/api/v1/proposals/batch/*', async (route: Route) => {
    const action = route.request().url().endsWith('/approve') ? 'approve' : 'reject';
    const body = route.request().postDataJSON() as { ids: number[] };
    state.submissions.push({ action, ids: body.ids });
    const results = state.onBatch(action, body.ids);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ results }),
    });
  });

  return state;
}

test.describe('proposal visible selection', () => {
  test.use({ storageState: stateFor('dm') });

  test('filtering clears hidden ids, announces it, confirms action types, and submits only visible ids', async ({ page }) => {
    const { campaignId } = seed();
    const api = await mockProposalApi(page, [
      proposal(101, {
        action: 'create',
        entityType: 'quest',
        payload: { title: 'Human quest' },
      }),
      proposal(102, {
        action: 'update',
        entityType: 'npc',
        payload: { name: 'AI NPC' },
        proposer: 'AI DM',
        proposerUserId: `ai-dm:${campaignId}`,
      }),
      proposal(103, {
        action: 'delete',
        entityType: 'location',
        payload: {},
        snapshot: { name: 'AI location' },
        proposer: 'AI DM',
        proposerUserId: `ai-dm:${campaignId}`,
      }),
    ]);

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('checkbox', { name: 'Select proposal 101' }).check();
    await page.getByRole('checkbox', { name: 'Select proposal 102' }).check();
    await page.getByRole('checkbox', { name: 'Select proposal 103' }).check();
    await expect(page.getByRole('checkbox', { name: '3 of 3 selected' })).toBeChecked();

    const filter = page.getByRole('checkbox', { name: 'AI drafts only (2)' });
    await filter.check();

    await expect(page.getByText('Create quest "Human quest"')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '2 of 2 selected' })).toBeChecked();
    await expect(page.getByText(
      'AI drafts filter cleared 1 hidden selection. 2 visible proposals remain selected.',
      { exact: true },
    )).toBeAttached();

    await page.getByRole('button', { name: 'Approve 2', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve 2 selected proposals?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Only these 2 visible selected proposals will be approved.')).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Selected proposal types' })).toContainText('update: 1 proposal (1 npc)');
    await expect(dialog.getByRole('list', { name: 'Selected proposal types' })).toContainText('delete: 1 proposal (1 location)');
    await expect(dialog.getByText('1 delete proposal is destructive and will permanently remove the target.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve 2 proposals' }).click();

    await expect.poll(() => api.submissions).toEqual([{ action: 'approve', ids: [102, 103] }]);
    await expect(page.getByText('No AI drafts pending')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select all (0)' })).toBeDisabled();
    const activeEmptyFilter = page.getByRole('checkbox', { name: 'AI drafts only (0)' });
    await expect(activeEmptyFilter).toBeChecked();
    // Turning off the now-empty filter removes the control because there are no
    // AI rows left, so click rather than waiting for the old node to be unchecked.
    await activeEmptyFilter.click();
    await expect(page.getByText('Create quest "Human quest"')).toBeVisible();
  });

  test('select-all exposes checked/mixed semantics and filter/reject controls work from the keyboard', async ({ page }) => {
    const { campaignId } = seed();
    const api = await mockProposalApi(page, [
      proposal(201, { action: 'create', entityType: 'quest' }),
      proposal(202, { action: 'update', entityType: 'npc', proposerUserId: `ai-dm:${campaignId}` }),
      proposal(203, { action: 'delete', entityType: 'location', proposerUserId: `ai-dm:${campaignId}` }),
    ]);

    await page.goto(`/c/${campaignId}/proposals`);
    const selectAll = page.getByRole('checkbox', { name: 'Select all (3)' });
    await selectAll.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: '3 of 3 selected' })).toBeChecked();

    const aiUpdate = page.getByRole('checkbox', { name: 'Select proposal 202' });
    await aiUpdate.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: '2 of 3 selected' })).toBeChecked({ indeterminate: true });

    const filter = page.getByRole('checkbox', { name: 'AI drafts only (2)' });
    await filter.focus();
    await page.keyboard.press('Space');
    await expect(filter).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '1 of 2 selected' })).toBeChecked({ indeterminate: true });
    await expect(page.getByText(
      'AI drafts filter cleared 1 hidden selection. 1 visible proposal remains selected.',
      { exact: true },
    )).toBeAttached();

    const reject = page.getByRole('button', { name: 'Reject 1', exact: true });
    await reject.click();
    const dialog = page.getByRole('dialog', { name: 'Reject 1 selected proposal?' });
    await expect(dialog.getByText('1 delete proposal is included; rejecting keeps the target unchanged.')).toBeVisible();
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Reject 1 proposal' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reject).toBeFocused();

    await reject.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reject 1 proposal' }).click();
    await expect.poll(() => api.submissions).toEqual([{ action: 'reject', ids: [203] }]);
  });

  test('partial failure keeps only failed pending ids selected', async ({ page }) => {
    const { campaignId } = seed();
    const rows = [
      proposal(301, { action: 'create', entityType: 'quest' }),
      proposal(302, { action: 'update', entityType: 'npc' }),
      proposal(303, { action: 'create', entityType: 'location' }),
    ];
    const api = await mockProposalApi(page, rows);
    api.onBatch = (_action, ids) => {
      api.pending = [rows[1]];
      return ids.map((id) => id === 302
        ? { id, ok: false, status: 400, error: 'Invalid proposal payload' }
        : { id, ok: true });
    };

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('checkbox', { name: 'Select all (3)' }).check();
    await page.getByRole('button', { name: 'Approve 3', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve 3 proposals' }).click();

    await expect.poll(() => api.submissions).toEqual([{ action: 'approve', ids: [301, 302, 303] }]);
    await expect(page.getByRole('alert').filter({ hasText: "1 of 3 couldn't be approved" }))
      .toContainText("1 of 3 couldn't be approved: Invalid proposal payload");
    await expect(page.getByRole('checkbox', { name: '1 of 1 selected' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select proposal 302' })).toBeChecked();
  });

  test('concurrent resolution removes a failed stale id after refresh', async ({ page }) => {
    const { campaignId } = seed();
    const api = await mockProposalApi(page, [
      proposal(401, { action: 'create', entityType: 'quest' }),
      proposal(402, { action: 'update', entityType: 'npc' }),
    ]);
    api.onBatch = () => {
      // 402 was resolved by another actor after this page rendered; 401 succeeds
      // here. The refresh is authoritative and contains neither stale id.
      api.pending = [];
      return [
        { id: 401, ok: true },
        { id: 402, ok: false, status: 409, error: 'Proposal 402 is already approved' },
      ];
    };

    await page.goto(`/c/${campaignId}/proposals`);
    await page.getByRole('checkbox', { name: 'Select all (2)' }).check();
    await page.getByRole('button', { name: 'Approve 2', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve 2 proposals' }).click();

    await expect.poll(() => api.submissions).toEqual([{ action: 'approve', ids: [401, 402] }]);
    await expect(page.getByRole('alert').filter({ hasText: "1 of 2 couldn't be approved" }))
      .toContainText("1 of 2 couldn't be approved: Proposal 402 is already approved");
    await expect(page.getByText('No pending proposals')).toBeVisible();
    await expect(page.getByRole('button', { name: /Approve \d/ })).toHaveCount(0);
  });
});
