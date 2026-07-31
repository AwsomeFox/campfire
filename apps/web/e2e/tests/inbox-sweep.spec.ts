import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #1646 — the scribe-inbox page already told the DM "or let Claude sweep them
 * for you", but there was no Sweep control: the copy pointed at connecting an MCP
 * assistant via an API token, and that was the only way to trigger a sweep.
 *
 * The server orchestration itself (issue #1644, `InboxSweepService.sweep()`) is proven
 * end-to-end against real SQLite in `apps/server/test/inbox-sweep.e2e-spec.ts` (REST)
 * and `apps/server/test/inbox-sweep-mcp.e2e-spec.ts` (MCP) — a scripted classifier DI
 * override there produces REAL filed proposals from a REAL sweep call. This suite's job
 * is different: prove the WEB UI wiring — trigger, busy state, outcome rendering (with
 * per-item reasons, never swallowed), and the proposals-badge bump — not re-litigate
 * orchestration correctness. The classify step talks to a configured AI provider, which
 * the Playwright fixture campaign does not have, so `POST .../inbox/sweep` itself is
 * mocked here (same convention as ai-table-shared-transcript.spec.ts's driver mocks) to
 * get a deterministic "some proposed, some force-skipped" result without depending on
 * live model output.
 *
 * Serial (mirrors campaign-status-confirm.spec.ts): the archived-campaign test flips the
 * shared seeded campaign's status and restores it before finishing — running in parallel
 * with anything else that assumes Active would be flaky.
 */
test.describe.configure({ mode: 'serial' });

test.describe('scribe inbox sweep control', () => {
  test.use({ storageState: stateFor('dm') });

  test('triggers a sweep, shows a busy state, and surfaces per-item outcomes with reasons', async ({ browser, page }) => {
    const { campaignId } = seed();

    // A real open item so the button isn't disabled for "nothing to sweep", and so the
    // proposed outcome's body-lookup path (not just its noteId fallback) is exercised.
    const player = await browser.newContext({ storageState: stateFor('player') });
    const body = `Sweep target ${Date.now()}`;
    const submitted = await player.request.post(`/api/v1/campaigns/${campaignId}/inbox`, { data: { body } });
    expect(submitted.ok()).toBe(true);
    const realItem = await submitted.json();
    await player.close();

    const skipReason =
      'objective ticks, HP changes, and combat/initiative writes are not handled by the inbox sweep — resolve this item directly';
    const proposeReason = 'filed as create proposal #4242: players raised a new quest hook';
    const fakeSkippedNoteId = realItem.id + 1_000_000; // no local body — exercises the "Note #id" fallback label

    let releaseSweep!: () => void;
    const sweepGate = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    let sweepCalls = 0;
    await page.route(`**/api/v1/campaigns/${campaignId}/inbox/sweep`, async (route) => {
      sweepCalls += 1;
      await sweepGate;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 999,
            campaignId,
            status: 'succeeded',
            itemsTotal: 3,
            itemsProposed: 2,
            itemsSkipped: 1,
            itemsErrored: 0,
            detail: 'swept 3 item(s): 2 proposed, 1 skipped, 0 errored',
            createdBy: 'user:dm',
            createdAt: new Date().toISOString(),
          },
          items: [
            {
              noteId: realItem.id,
              outcome: 'proposed',
              entityType: 'quest',
              entityId: null,
              proposalId: 4242,
              reason: proposeReason,
            },
            {
              noteId: fakeSkippedNoteId,
              outcome: 'skipped',
              entityType: null,
              entityId: null,
              proposalId: null,
              reason: skipReason,
            },
            {
              noteId: 7575,
              outcome: 'proposed',
              entityType: 'npc',
              entityId: null,
              proposalId: 4243,
              reason: 'filed as create proposal #4243: new NPC introduced',
              body: 'Item 75 beyond initial page',
            },
          ],
        }),
      });
    });

    await page.goto(`/c/${campaignId}/inbox`);
    // The label switches to "Sweeping…" while busy (asserted below), so match either —
    // it's the same button throughout.
    const sweepButton = page.getByRole('button', { name: /Sweep inbox with AI|Sweeping…/ });
    await expect(sweepButton).toBeEnabled();

    const proposalsNav = page.getByRole('link', { name: /Proposals/ });
    const badgeBefore = (await proposalsNav.textContent()) ?? '';

    await sweepButton.click();

    // Busy state: the endpoint is a long-running classification pass (issue #1646) — the
    // button must visibly change, not just sit there disabled with no explanation.
    await expect(sweepButton).toBeDisabled();
    await expect(page.getByText('Sweeping…')).toBeVisible();
    await expect(page.getByText(/can take a while/)).toBeVisible();

    releaseSweep();
    await expect.poll(() => sweepCalls).toBe(1);

    // Outcome summary + per-item reasons — the force-skip reason must reach the DM
    // verbatim, not be summarized away.
    await expect(page.getByText(/Swept 3 item\(s\): 2 proposed, 1 skipped, 0 errored/)).toBeVisible();
    const outcomeList = page.getByRole('list').filter({ hasText: proposeReason });
    await expect(outcomeList.getByText(proposeReason)).toBeVisible();
    await expect(outcomeList.getByText(skipReason)).toBeVisible();
    await expect(outcomeList.getByText(body)).toBeVisible(); // the proposed item's own body, via the noteId lookup
    await expect(outcomeList.getByText('Item 75 beyond initial page')).toBeVisible(); // item beyond initial page with server-provided body
    await expect(outcomeList.getByText(`Note #${fakeSkippedNoteId}`)).toBeVisible(); // fallback label path

    // The proposals-queue badge reflects the newly filed proposal without a route change.
    await expect(async () => {
      const after = (await proposalsNav.textContent()) ?? '';
      expect(after).not.toBe(badgeBefore);
    }).toPass();

    const reviewLink = page.getByRole('link', { name: 'Review filed proposals' });
    await expect(reviewLink).toHaveAttribute('href', `/c/${campaignId}/proposals`);
    await reviewLink.click();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/proposals$`));
  });

  test('is disabled with a stated reason for an archived campaign', async ({ browser, page }) => {
    const { campaignId } = seed();
    const dm = await browser.newContext({ storageState: stateFor('dm') });
    const before = await dm.request.get(`/api/v1/campaigns/${campaignId}`);
    const beforeJson = (await before.json()) as { status: string; publicInvitesEnabled: boolean };
    const beforeStatus = beforeJson.status;
    const beforeInvites = beforeJson.publicInvitesEnabled;

    const archived = await dm.request.patch(`/api/v1/campaigns/${campaignId}`, { data: { status: 'completed' } });
    expect(archived.ok()).toBe(true);
    try {
      await page.goto(`/c/${campaignId}/inbox`);
      const sweepButton = page.getByRole('button', { name: 'Sweep inbox with AI' });
      await expect(sweepButton).toBeDisabled();
      await expect(page.getByText(/archived, read-only/)).toBeVisible();
    } finally {
      // Restore the seed fixture for later tests/workers sharing this campaign.
      // Archiving suspends public invites; restoring the campaign status does not
      // revive them, so re-enable the previous policy if it was enabled.
      const restore = await dm.request.patch(`/api/v1/campaigns/${campaignId}`, {
        data: { status: beforeStatus },
      });
      expect(restore.ok()).toBe(true);
      if (beforeInvites) {
        const restoreInvites = await dm.request.put(`/api/v1/campaigns/${campaignId}/invites/policy`, {
          data: { enabled: true },
        });
        expect(restoreInvites.ok()).toBe(true);
      }
      await dm.close();
    }
  });
});
