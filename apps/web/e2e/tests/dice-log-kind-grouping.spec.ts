import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Campaign } from '@campfire/schema';
import { stateFor } from './seed';

test.use({ storageState: stateFor('dm') });

/**
 * Shared dice log literal per-kind grouping (issue #2183, follow-up to #2155/#2182).
 *
 * Real rendered-DOM coverage, not a source scan: submits a sequence of rolls whose
 * `kind`s interleave a run of same-kind rolls with a different-kind row and an
 * unclassified (manual/physical) row, then asserts the ACTUAL row order and each
 * row's `data-dice-roll-group` role in the live log — plus (PR #2195 review: a
 * background tint here failed axe `color-contrast` against the same-token-coloured
 * roll total text it sat behind) an axe scan over the whole banded log, so a future
 * change that reintroduces a contrast-losing treatment fails here, not by luck of
 * which spec's fixture happens to roll two same-kind totals next to each other.
 *
 * Runs in its OWN freshly-created campaign (not the shared seed campaign every other
 * dice-log spec rolls into) — this test's assertions depend on exact row count and
 * order, which a concurrently-running spec rolling into a shared campaign would
 * otherwise be free to perturb.
 *
 * Submitted in order (oldest to newest): roll1('roll'), roll2(manual/unclassified),
 * roll3('roll'), roll4('roll'). Rendered newest-first, that is
 * [roll4, roll3, roll2, roll1]. Because grouping only looks at chronologically
 * ADJACENT rows (never reorders, never bridges across a different kind), roll4+roll3
 * form one run (a literal group, start+end) while roll1 stays solo even though it
 * shares roll3/roll4's kind — roll2 sits between them in time.
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

    await rollFree('grouping-1');
    await rollManual('grouping-2');
    await rollFree('grouping-3');
    await rollFree('grouping-4');

    await page.goto(`/c/${campaignId}`);
    const log = page.getByTestId('shared-dice-log');
    await expect(log).toBeVisible();
    await expect(log.getByText('grouping-4', { exact: false })).toBeVisible();

    const rows = log.locator('[data-dice-roll-group]');
    await expect(rows).toHaveCount(4);

    // Rendered order is strictly chronological (newest first) — grouping must not reorder it.
    const kinds = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-dice-roll-kind')));
    const groups = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-dice-roll-group')));
    expect(kinds).toEqual(['roll', 'roll', 'unclassified', 'roll']);

    // roll4 (index 0) + roll3 (index 1): consecutive, same kind — a genuine run (start/end).
    // roll2 (index 2): unclassified — always solo, never absorbed into a neighbour's run.
    // roll1 (index 3): kind 'roll' too, but roll2 sits between it and the run in time, so
    // it is NOT bridged into that run — solo, exactly like an unrelated kind would be.
    expect(groups).toEqual(['start', 'end', 'solo', 'solo']);

    // The grouped rows carry a coloured left-accent border. Confirm that treatment never
    // regresses to something axe flags (e.g. a background tint behind same-token text —
    // see the PR #2195 review finding this test was added to guard against).
    const results = await new AxeBuilder({ page }).include('[data-testid="shared-dice-log"]').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});
