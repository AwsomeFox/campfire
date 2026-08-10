import { expect, test } from '@playwright/test';
import type { Campaign } from '@campfire/schema';
import { stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

/**
 * Shared dice log literal per-kind grouping (issue #2183, follow-up to #2155/#2182).
 *
 * Real rendered-DOM coverage, not a source scan: submits a sequence of rolls whose
 * `kind`s interleave a run of same-kind rolls around a different-kind row and an
 * unclassified (manual/physical) row, then asserts the ACTUAL row order and each
 * row's `data-dice-roll-group` role in the live log.
 *
 * Runs in its OWN freshly-created campaign (not the shared seed campaign every other
 * dice-log spec rolls into) — this test's assertions depend on exact row count and
 * order, which a concurrently-running spec rolling into a shared campaign would
 * otherwise be free to perturb.
 *
 * Sequence submitted (oldest to newest): D('roll'), C(manual/unclassified),
 * B('roll'), A('roll'). Rendered newest-first, that is [A, B, C, D]. Because
 * grouping only looks at chronologically-ADJACENT rows (never reorders and never
 * bridges across a different kind), A+B form one run (a literal group) while D
 * stays solo even though it shares B/A's kind — C sits between them in time.
 */
test.describe('shared dice log kind grouping (#2183)', () => {
  test('bands a run of consecutive same-kind rolls without reordering the chronological log, and never groups an unclassified roll', async ({ page }) => {
    const created = await page.request.post('/api/v1/campaigns', {
      data: { name: `E2E2183 Grouping ${Date.now()}` },
    });
    expect(created.ok()).toBe(true);
    const campaign = (await created.json()) as Campaign;
    const campaignId = campaign.id;

    async function rollFree(label: string) {
      const res = await page.request.post(`/api/v1/campaigns/${campaignId}/roll`, {
        data: { expr: '1d20', label },
      });
      expect(res.ok()).toBe(true);
    }

    async function rollManual(label: string) {
      const res = await page.request.post(`/api/v1/campaigns/${campaignId}/roll/manual`, {
        data: { total: 11, label },
      });
      expect(res.ok()).toBe(true);
    }

    await rollFree('grouping-D');
    await rollManual('grouping-C');
    await rollFree('grouping-B');
    await rollFree('grouping-A');

    await page.goto(`/c/${campaignId}`);
    const log = page.getByTestId('shared-dice-log');
    await expect(log).toBeVisible();
    await expect(log.getByText('grouping-A', { exact: false })).toBeVisible();

    const rows = log.locator('[data-dice-roll-group]');
    await expect(rows).toHaveCount(4);

    // Rendered order is strictly chronological (newest first) — grouping must not reorder it.
    const kinds = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-dice-roll-kind')));
    const groups = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-dice-roll-group')));
    expect(kinds).toEqual(['roll', 'unclassified', 'roll', 'roll']);

    // A (index 0): kind 'roll', but its chronological neighbour C is unclassified — solo.
    // C (index 1): unclassified — always solo, never absorbed into a neighbour's run.
    // B (index 2) + D (index 3): a genuine consecutive same-kind run — start/end.
    expect(groups).toEqual(['solo', 'solo', 'start', 'end']);
  });
});
