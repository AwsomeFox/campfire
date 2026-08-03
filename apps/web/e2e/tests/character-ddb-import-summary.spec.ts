import { expect, test } from '@playwright/test';
import { stateFor } from './seed';

/**
 * Issue #1903 — the D&D Beyond import summary panel (attacks/spells/slots counts + any
 * text-only entries) must actually be visible to the importer, not thrown away the instant
 * the import succeeds.
 *
 * Regression for a review finding on PR #1950: `importFromDdb()` originally called
 * `onCreated()` (wired by PartyPage to `closeCreating()` + a roster reload) BEFORE
 * `setImportSummary(res.summary)`. PartyPage only renders `NewCharacterForm` while
 * `creating || party.length === 0`; both `closeCreating()` and the reload's `loading=true`
 * flip that guard false on the very next render, unmounting the form before the
 * just-set summary state could ever paint. `onCreated()` must not fire until the user
 * dismisses the summary via "Done".
 *
 * The real D&D Beyond service isn't reachable from CI, so the backend's import endpoint is
 * intercepted at the browser/network boundary (same technique used elsewhere in this suite,
 * e.g. campaign-events-identity-switch.spec.ts) and answered with a fixed, schema-shaped
 * `{ character, summary }` body — this test is about the React lifecycle, not the importer.
 * Showing the import affordance at all needs `ruleSystem` to resolve to an adapter with
 * `supportsDdbImport: true` (`ddbImportSupported`, apps/web/src/lib/rules.ts), which in turn
 * needs a real *installed* rule pack row server-side (campaigns.service's `validateRuleSystem`)
 * — not available to a plain API-only e2e seed. So the campaign is created with no ruleSystem
 * (a valid, ungated create) and only the `GET /api/v1/campaigns` list response the
 * CampaignContext provider reads is intercepted to report `ruleSystem: 'open5e-srd'` for it;
 * every other request (party roster, membership, etc.) hits the real backend unmodified.
 *
 * Critically, the party is seeded with one REAL character first. PartyPage's render guard is
 * `creating || party.length === 0` — with an empty party that guard stays true regardless of
 * `creating`, papering over the exact bug this test exists to catch (which the original review
 * finding described for "a party that already has characters"). A non-empty party makes
 * `creating` alone control the form's mount state, so a premature `onCreated()` (which flips
 * `creating` to false) genuinely unmounts the form before this test's assertions run.
 */
test.describe('D&D Beyond import summary stays visible until dismissed (issue #1903)', () => {
  test.use({ storageState: stateFor('dm') });

  test('summary panel survives the render after a successful import, and Done closes it', async ({ page, baseURL }) => {
    const campaignRes = await page.request.post('/api/v1/campaigns', {
      data: { name: `1903 DDB Import ${Date.now()}` },
    });
    expect(campaignRes.ok()).toBe(true);
    const campaign = (await campaignRes.json()) as { id: number; [key: string]: unknown };
    const campaignId = campaign.id;

    const seedRes = await page.request.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Existing PC', className: 'Fighter', level: 1 },
    });
    expect(seedRes.ok()).toBe(true);

    await page.route(`${baseURL}/api/v1/campaigns`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const list = (await res.json()) as Array<{ id: number; [key: string]: unknown }>;
      const patched = list.map((c) => (c.id === campaignId ? { ...c, ruleSystem: 'open5e-srd' } : c));
      await route.fulfill({ response: res, json: patched });
    });

    const importPath = `/api/v1/campaigns/${campaignId}/characters/import-ddb`;
    await page.route(`${baseURL}${importPath}`, async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          character: { id: 999999, name: 'Imported Hero', className: 'Fighter', level: 5, status: 'active' },
          summary: {
            actionsImported: 2,
            spellsImported: 3,
            spellSlotsImported: true,
            textOnly: ['Unparseable Feature'],
          },
        }),
      });
    });

    // ?action=new opens the create form on a NON-empty party (one seeded above) — the
    // scenario the original review finding was about.
    await page.goto(`/c/${campaignId}/party?action=new`);

    const ddbInput = page.getByLabel('D&D Beyond character id or URL');
    await expect(ddbInput).toBeVisible();
    await ddbInput.fill('123456');
    await page.getByRole('button', { name: 'Import' }).click();

    const summaryPanel = page.getByRole('status');
    await expect(summaryPanel).toBeVisible();
    await expect(summaryPanel.getByText('Imported from D&D Beyond')).toBeVisible();
    await expect(summaryPanel.getByText('2 attacks/actions imported')).toBeVisible();
    await expect(summaryPanel.getByText('3 spells imported')).toBeVisible();
    await expect(summaryPanel.getByText('Spell slots set from class and level.')).toBeVisible();
    await expect(summaryPanel.getByText('Unparseable Feature')).toBeVisible();
    const doneBtn = summaryPanel.getByRole('button', { name: 'Done' });
    await expect(doneBtn).toBeVisible();

    // The regression: confirm the panel is not a one-render flash by giving React and any
    // (mocked, near-instant) reload every chance to unmount it before asserting again.
    await page.waitForTimeout(300);
    await expect(summaryPanel).toBeVisible();
    await expect(doneBtn).toBeVisible();

    // Dismissing via Done is what triggers the deferred onCreated() (close + reload). With a
    // non-empty party and creating flipped false, the whole create form (not just the
    // summary) goes away — the page header's "+ New character" affordance is what's back.
    await doneBtn.click();
    await expect(summaryPanel).toHaveCount(0);
    await expect(ddbInput).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ New character' })).toBeVisible();
  });
});
