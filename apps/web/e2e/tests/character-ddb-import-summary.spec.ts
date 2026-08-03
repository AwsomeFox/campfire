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

  // Regression for a follow-up review finding: the fix above was only proven for a
  // NON-empty party. When the form is showing purely because `party.length === 0` (no
  // `?action=new`, `creating` still false), a successful import's roster reload flips
  // `party.length` to 1 — which, on its own, satisfies neither half of PartyPage's OLD
  // guard (`creating` is still false) — so the guard flips false and unmounts the form,
  // discarding the summary before "Done" can be read. NewCharacterForm's new
  // `onImportSucceeded` prop must pin PartyPage's `creating` flag true to prevent this.
  test('summary panel survives the reload when the import happens on an initially-empty party', async ({ page, baseURL }) => {
    const campaignRes = await page.request.post('/api/v1/campaigns', {
      data: { name: `1903 DDB Import Empty Party ${Date.now()}` },
    });
    expect(campaignRes.ok()).toBe(true);
    const campaign = (await campaignRes.json()) as { id: number; [key: string]: unknown };
    const campaignId = campaign.id;

    await page.route(`${baseURL}/api/v1/campaigns`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const list = (await res.json()) as Array<{ id: number; [key: string]: unknown }>;
      const patched = list.map((c) => (c.id === campaignId ? { ...c, ruleSystem: 'open5e-srd' } : c));
      await route.fulfill({ response: res, json: patched });
    });

    // The roster starts empty (real state), then flips to one entry after import — mirroring
    // the real reload's effect once the character actually exists — without needing a real
    // DDB-import round trip against the fake sheet fixture.
    // A full PartyCharacter shape (RosterCharacterCard reads hpMax/hpCurrent/conditions
    // unconditionally) — a sparser fixture renders fine right up until this exact scenario
    // exercises the real roster-card render path, which a too-thin mock would crash.
    const importedRosterEntry = {
      id: 999999,
      name: 'Imported Hero',
      className: 'Fighter',
      level: 5,
      status: 'active',
      portraitUrl: null,
      hpMax: 10,
      hpCurrent: 10,
      conditions: [],
    };
    let imported = false;
    await page.route(`${baseURL}/api/v1/campaigns/${campaignId}/characters/roster`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const body = imported ? [importedRosterEntry] : [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const importPath = `/api/v1/campaigns/${campaignId}/characters/import-ddb`;
    await page.route(`${baseURL}${importPath}`, async (route) => {
      imported = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          character: { id: 999999, name: 'Imported Hero', className: 'Fighter', level: 5, status: 'active' },
          summary: { actionsImported: 1, spellsImported: 0, spellSlotsImported: false, textOnly: [] },
        }),
      });
    });

    // No ?action=new: the form shows purely because the (real, empty) party has no members.
    await page.goto(`/c/${campaignId}/party`);

    const ddbInput = page.getByLabel('D&D Beyond character id or URL');
    await expect(ddbInput).toBeVisible();
    await ddbInput.fill('123456');
    await page.getByRole('button', { name: 'Import' }).click();

    const summaryPanel = page.getByRole('status');
    await expect(summaryPanel).toBeVisible();
    await expect(summaryPanel.getByText('Imported from D&D Beyond')).toBeVisible();
    const doneBtn = summaryPanel.getByRole('button', { name: 'Done' });
    await expect(doneBtn).toBeVisible();

    // PartyPage polls the roster every 5s (usePollWhileVisible) even with no explicit
    // reload triggered yet — wait past one full cycle so the roster route above genuinely
    // flips party.length from 0 to 1 during the test, giving the pre-fix guard
    // (`creating || party.length === 0`) a real chance to go false and unmount the form.
    await page.waitForTimeout(6000);
    await expect(summaryPanel).toBeVisible();
    await expect(doneBtn).toBeVisible();

    await doneBtn.click();
    await expect(summaryPanel).toHaveCount(0);
  });
});
