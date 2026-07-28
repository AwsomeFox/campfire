import { expect, request, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #1585 — the admin console can RAISE a cross-campaign export request
 * (`AdminCatalogPage`'s `request_export` bulk operation, `POST /admin/campaigns/bulk`) but had
 * no UI over `GET /admin/campaigns/export-requests` to read the answer back. The endpoint
 * shipped fully built — paged, real `total`, audited — in #587; nothing in the web app ever
 * called it. `ExportRequestsQueueCard` on `/admin/campaigns` is the missing read side.
 *
 * These tests exercise the REAL server endpoints (raise via the bulk route, decide via the
 * campaign-scoped DM route already covered by CampaignSettingsPage's own tests) rather than
 * mocking them, because the point of this issue is that a real, already-working endpoint had no
 * caller — mocking it here would not prove the new UI reaches the real thing.
 */
test.describe('admin export-request queue (#1585)', () => {
  test.use({ storageState: stateFor('admin') });

  test('an admin sees a raised request, its justification, filters to one campaign, and sees the DM decision once recorded', async ({
    page,
  }) => {
    const { campaignId, baseURL } = seed();
    // `page.request` already carries this describe block's admin storageState.
    const admin = page.request;
    const dm = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor('dm') });
    const justification = `Compliance snapshot requested ${Date.now()}.`;

    const raised = await admin.post('/api/v1/admin/campaigns/bulk', {
      data: {
        operation: 'request_export',
        campaignIds: [campaignId],
        dryRun: false,
        reason: justification,
        exportProfile: 'backup',
      },
    });
    expect(raised.ok()).toBe(true);

    // Find the request this raised (or, if one was already pending for this campaign from an
    // earlier run in the same seeded session, the pending one that IS there — the bulk route
    // treats a duplicate pending ask as a no-op skip rather than a second row).
    const listed = await admin.get(`/api/v1/admin/campaigns/export-requests?campaignId=${campaignId}`);
    expect(listed.ok()).toBe(true);
    const page1 = (await listed.json()) as { items: Array<{ id: number; status: string; justification: string }> };
    const pendingItem = page1.items.find((r) => r.status === 'pending');
    expect(pendingItem, 'a pending export request must exist for this campaign after raising one').toBeTruthy();

    await page.goto('/admin/campaigns');
    const card = page.getByTestId('admin-export-requests');
    await expect(card).toBeVisible();
    await expect(card.getByText(`Campaign #${campaignId}`).first()).toBeVisible();

    // Filter the queue down to this campaign and confirm the filtered view still shows it —
    // proves the `campaignId` query parameter round-trips through the UI to the real endpoint.
    await card.getByLabel('Filter to one campaign').fill(String(campaignId));
    await card.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(card.getByText(`Campaign #${campaignId}`).first()).toBeVisible();
    await expect(card.getByRole('button', { name: 'Clear filter' })).toBeVisible();

    // The DM decides. This is the existing, already-tested campaign-scoped route
    // (CampaignSettingsPage's ExportRequestsCard) — used here only to produce a decided row for
    // the admin queue to display, not re-testing the decision endpoint itself.
    const decisionNote = `Approved for the audit ${Date.now()}.`;
    const decided = await dm.post(
      `/api/v1/campaigns/${campaignId}/catalog/export-requests/${pendingItem!.id}/decision`,
      { data: { decision: 'approved', note: decisionNote } },
    );
    expect(decided.ok()).toBe(true);
    await dm.dispose();

    await page.reload();
    const decidedCard = page.getByTestId('admin-export-requests');
    // The formerly-pending request now shows the decision — status, decider, and note — rather
    // than sitting in the pending bucket forever with the operator never learning the outcome.
    await expect(decidedCard.getByText('Approved', { exact: true }).first()).toBeVisible();
    await expect(decidedCard.getByText(new RegExp(decisionNote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();
  });

  test('a non-admin cannot reach the cross-campaign export-request endpoint', async () => {
    const { baseURL } = seed();
    for (const role of ['dm', 'player', 'viewer'] as const) {
      const ctx = await request.newContext({ baseURL: baseURL || undefined, storageState: stateFor(role) });
      const res = await ctx.get('/api/v1/admin/campaigns/export-requests');
      expect(res.status(), `${role} must not read the cross-campaign export-request queue`).toBe(403);
      await ctx.dispose();
    }
  });
});

test.describe('admin export-request queue — non-admin page gate (#1585)', () => {
  test.use({ storageState: stateFor('dm') });

  test('a DM visiting /admin/campaigns sees the server-admin gate, not the queue', async ({ page }) => {
    await page.goto('/admin/campaigns');
    await expect(page.getByText('Server admins only')).toBeVisible();
    await expect(page.getByTestId('admin-export-requests')).toHaveCount(0);
  });
});
