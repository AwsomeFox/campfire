import { expect, request, test } from '@playwright/test';
import { CREDS } from '../global-setup';
import { seed, stateFor } from './seed';

/**
 * The character sheet's play surface, from the Claude Design template
 * `templates/character-sheet/CharacterSheet.dc.html`.
 *
 * Three claims that only a real browser can settle:
 *  - the vitals rail (HP, temp HP, conditions, rests) is OUTSIDE both tabpanels, so it
 *    survives a switch to Build — the whole reason the template pulls it into a rail;
 *  - an ability score rolls a server-resolved catalog check, like Skills and Saves,
 *    rather than a modifier the sheet computed for itself;
 *  - temp HP is its own pool, PATCHed on the character, not folded into POST /hp.
 */
test.describe('character sheet play surface', () => {
  test.use({ storageState: stateFor('dm') });

  test('the vitals rail stays put across a tab switch', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const rail = page.getByTestId('character-vitals-rail');
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Hit points & Defenses' })).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Conditions' })).toBeVisible();
    await expect(page.getByTestId('character-vitals')).toBeVisible();

    await page.getByRole('tab', { name: /Build & profile/ }).click();
    await expect(page.getByTestId('character-sheet-panel-build')).toBeVisible();
    // The Play panel is hidden, the rail is not.
    await expect(page.getByTestId('character-sheet-panel-play')).toBeHidden();
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Hit points & Defenses' })).toBeVisible();
  });

  test('an ability score rolls a catalog check server-side', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    // Needs real scores: an ability the sheet never had is deliberately not rollable
    // (see the draft-sheet test below), and the seeded character has no stats at all.
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Rolls Its Abilities', className: 'Ranger', level: 3, stats: { STR: 10, DEX: 16, CON: 12, INT: 12, WIS: 14, CHA: 10 } },
    })).json()).id as number;

    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      const dex = page.getByRole('button', { name: /^Roll DEX check/ });
      await expect(dex).toBeVisible();

      // The sheet must not roll this itself: the modifier and the die both come from
      // POST /characters/:id/checks/roll, the same endpoint Skills and Saves use.
      const rolled = page.waitForResponse(
        (res) => res.url().includes(`/api/v1/characters/${characterId}/checks/roll`) && res.request().method() === 'POST',
      );
      await dex.click();
      const response = await rolled;
      expect(response.ok()).toBeTruthy();
      expect(JSON.parse(response.request().postData() ?? '{}')).toMatchObject({ checkId: 'ability:DEX' });
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  test('temp HP is a separate pool, patched on the character', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const value = page.getByTestId('character-temp-hp-value');
    await expect(value).toHaveText('0');

    const patched = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/v1/characters/${navigation.characterId}`) &&
        res.request().method() === 'PATCH',
    );
    await page.getByTestId('character-temp-hp').getByRole('button', { name: /Add 1 temporary hit point/ }).click();
    const response = await patched;
    expect(JSON.parse(response.request().postData() ?? '{}')).toEqual({ hpTemp: 1 });
    await expect(value).toHaveText('1');

    // Restore, so the shared seeded character is left as it was found.
    const ctx = await request.newContext({ baseURL: new URL(page.url()).origin });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    await ctx.patch(`/api/v1/characters/${navigation.characterId}`, { data: { hpTemp: 0 } });
    await ctx.dispose();
  });

  /**
   * An equipped item's `equippedAction` is already usable in an encounter. Before this,
   * the sheet listed only `character.actions`, so a geared character's options were
   * invisible outside combat — the gap the template's 🎒 chips close.
   */
  test('an equipped item\'s action appears in Actions, and is locked while stowed', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });

    const characterRes = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Play Surface Gear Test', className: 'Fighter', level: 3 },
    });
    expect(characterRes.ok()).toBeTruthy();
    const characterId = (await characterRes.json()).id as number;

    try {
      const itemRes = await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
        data: { name: 'Flame Tongue Shortsword', qty: 1, ownerType: 'character', characterId },
      });
      expect(itemRes.ok()).toBeTruthy();
      const itemId = (await itemRes.json()).id as number;
      const equipped = await ctx.patch(`/api/v1/inventory/${itemId}`, {
        data: {
          equipped: true,
          equipSlot: 'main hand',
          equippedAction: { name: 'Flame Tongue Strike', kind: 'melee', toHit: '+6', damage: '1d6+2', notes: '', targetAc: '' },
        },
      });
      expect(equipped.ok()).toBeTruthy();

      await page.goto(`/c/${campaignId}/characters/${characterId}`);
      const gear = page.getByTestId('character-granted-actions');
      await expect(gear.getByText('Flame Tongue Strike')).toBeVisible();
      await expect(gear.getByRole('button', { name: /Flame Tongue Shortsword/ })).toBeVisible();
      // Equipped: the action is rollable from the sheet.
      await expect(gear.getByRole('button', { name: /to hit \+6/ })).toBeVisible();

      // The 🎒 chip is the template's cross-navigation into the pack it came from.
      await gear.getByRole('button', { name: /Flame Tongue Shortsword/ }).click();
      await expect(page).toHaveURL(/tab=build/);
      await expect(page.getByTestId('character-inventory')).toBeVisible();

      // Stowed: still listed (so "why can't I use this?" is answerable), but not rollable.
      const unequipped = await ctx.patch(`/api/v1/inventory/${itemId}`, { data: { equipped: false } });
      expect(unequipped.ok()).toBeTruthy();
      // ?tab=play explicitly: the 🎒 chip above persisted Build as this sheet's last tab.
      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      await expect(gear.getByText('Flame Tongue Strike')).toBeVisible();
      await expect(gear.getByText('Equip Flame Tongue Shortsword to use this action.')).toBeVisible();
      await expect(gear.getByRole('button', { name: /to hit \+6/ })).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): POST /characters/:id/checks/roll requires the DM
   * or owning player on a WRITABLE campaign (issue #1479). Read authority is dm-or-owner
   * too, so a viewer never sees the sheet — but an owner whose campaign has been archived
   * can still read it, and every roll control was live and 403-only for them.
   */
  test('an archived campaign leaves the roll controls inert rather than 403-only', async ({ page, baseURL }) => {
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    // A campaign of its own: archiving the shared seeded one would break every other spec.
    const campaign = await (await ctx.post('/api/v1/campaigns', { data: { name: 'Archived Sheet Campaign' } })).json();
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaign.id}/characters`, {
      data: { name: 'Frozen In Amber', className: 'Fighter', level: 3, stats: { STR: 16, DEX: 14, CON: 12, INT: 10, WIS: 10, CHA: 8 } },
    })).json()).id as number;

    try {
      // Active: the controls are live.
      await page.goto(`/c/${campaign.id}/characters/${characterId}?tab=play`);
      await expect(page.getByRole('button', { name: /^Roll STR check/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Roll initiative/ })).toBeVisible();

      const archived = await ctx.patch(`/api/v1/campaigns/${campaign.id}`, { data: { status: 'paused' } });
      expect(archived.ok()).toBeTruthy();

      // Archived: still readable by the owner, but nothing offers a roll it cannot make.
      await page.goto(`/c/${campaign.id}/characters/${characterId}?tab=play`);
      await expect(page.getByRole('heading', { level: 1, name: 'Frozen In Amber' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Roll STR check/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Roll initiative/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Roll .* save/ })).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/v1/campaigns/${campaign.id}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): Swords & Wizardry, Labyrinth Lord and OSE roll one
   * d6 per SIDE, but the neutral catalog still carries an initiative entry. A per-character
   * initiative tile there contradicts both the adapter and the encounter's group flow.
   */
  test('a group-initiative system gets no per-character initiative tile', async ({ page, baseURL }) => {
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    // The OSR variant slugs need their rule pack installed, so the two initiative models
    // are declared directly through `customMechanicsProfile` — the same seam the shipped
    // variants are built from (`createOsrVariantAdapter`).
    const profile = (slug: string, initiativeMode: 'group' | 'individual') => ({
      slug,
      label: slug,
      abilityTable: 'bx-banded' as const,
      abilityCap: 6,
      saves: ['Death', 'Wands', 'Paralysis', 'Breath', 'Spells'],
      acMode: 'descending' as const,
      acAnchor: 9,
      initiativeMode,
      initiativeDie: 6,
      initiativeUsesDexMod: true,
      tiebreak: 'dex-then-order' as const,
    });
    const group = await (await ctx.post('/api/v1/campaigns', {
      data: { name: 'Group Init Table', ruleSystem: 'homebrew-group', customMechanicsProfile: profile('homebrew-group', 'group') },
    })).json();
    const individual = await (await ctx.post('/api/v1/campaigns', {
      data: { name: 'Individual Init Table', ruleSystem: 'homebrew-solo', customMechanicsProfile: profile('homebrew-solo', 'individual') },
    })).json();
    const stats = { STR: 16, DEX: 14, CON: 12, INT: 10, WIS: 10, CHA: 8 };

    try {
      const groupCharacter = (await (await ctx.post(`/api/v1/campaigns/${group.id}/characters`, {
        data: { name: 'Rolls With The Party', className: 'Fighter', level: 2, stats },
      })).json()).id as number;
      const soloCharacter = (await (await ctx.post(`/api/v1/campaigns/${individual.id}/characters`, {
        data: { name: 'Rolls Alone', className: 'Fighter', level: 2, stats },
      })).json()).id as number;

      await page.goto(`/c/${group.id}/characters/${groupCharacter}?tab=play`);
      const vitals = page.getByTestId('character-vitals');
      await expect(vitals).toBeVisible();
      await expect(vitals.getByText('Initiative')).toHaveCount(0);

      // The sibling OSR variant that DOES roll individually keeps its tile.
      await page.goto(`/c/${individual.id}/characters/${soloCharacter}?tab=play`);
      await expect(page.getByTestId('character-vitals').getByText('Initiative')).toBeVisible();
    } finally {
      await ctx.delete(`/api/v1/campaigns/${group.id}`);
      await ctx.delete(`/api/v1/campaigns/${individual.id}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): an unset ability score is NOT a 10. The catalog
   * defaults a missing stat to 10, so trusting its modifier printed "— / +0" on a draft
   * sheet and let the player roll a check for a score they never set.
   */
  test('an ability with no score set is shown as unknown, not rolled as a 10', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    // STR set, DEX never filled in — a partially completed sheet. DEX is also what 5e
    // derives initiative from, so this covers the derived tile in the same fixture.
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Half Filled Sheet', className: 'Bard', level: 1, stats: { STR: 14 } },
    })).json()).id as number;

    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      const abilities = page.locator('#character-section-abilities');
      await expect(abilities).toBeVisible();

      // The filled one rolls.
      await expect(abilities.getByRole('button', { name: /^Roll STR check/ })).toBeVisible();
      // The unset one is inert, and never claims a modifier it does not have.
      await expect(abilities.getByRole('button', { name: /^Roll DEX check/ })).toHaveCount(0);
      const dex = abilities.locator('div').filter({ hasText: /^DEX/ }).last();
      await expect(dex).not.toContainText('+0');

      // Initiative derives from that same unset DEX, so it must not offer a roll either.
      const vitals = page.getByTestId('character-vitals');
      await expect(vitals.getByText('Initiative')).toBeVisible();
      await expect(vitals.getByRole('button', { name: /^Roll initiative/ })).toHaveCount(0);
      await expect(vitals).not.toContainText('+0');
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): an item's action can carry flat damage ("5 fire"),
   * which `damageExpr` returns null for because there are no dice. A truthiness check on
   * the expression hid the value entirely, where a sheet action keeps it as plain text.
   */
  test('a gear action with flat damage still shows the number', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Carries A Torch', className: 'Rogue', level: 2 },
    })).json()).id as number;

    try {
      const itemId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
        data: { name: 'Everburning Torch', qty: 1, ownerType: 'character', characterId },
      })).json()).id as number;
      await ctx.patch(`/api/v1/inventory/${itemId}`, {
        data: {
          equipped: true,
          equipSlot: 'off hand',
          equippedAction: { name: 'Torch Jab', kind: 'melee', toHit: '', damage: '5 fire', targetAc: '', notes: '' },
        },
      });

      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      const gear = page.getByTestId('character-granted-actions');
      await expect(gear.getByText('Torch Jab')).toBeVisible();
      await expect(gear.getByText('5 fire (flat)')).toBeVisible();
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): an action's Details panel was only mounted while
   * open, and its toggle is `cf-print-hide` — so a sheet printed in its default state
   * silently dropped every structured action's cost, range, save, effects and source, with
   * no stylesheet able to bring them back.
   */
  test('printing carries action details that were never opened on screen', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: {
        name: 'Prints Its Details',
        className: 'Wizard',
        level: 5,
        // A structured `spec` is what grows a Details panel (text inference happens in the
        // sheet's own editor, not on create), so this one is authored explicitly.
        actions: [{
          name: 'Scorching Ray',
          kind: 'spell',
          toHit: '',
          damage: '2d6 fire',
          targetAc: '',
          notes: '',
          spec: {
            mode: 'save',
            save: { ability: 'DEX', dc: { kind: 'fixed', dc: 15 } },
            range: { range: '120 ft' },
            outcomes: { failure: { text: 'The target is scorched.' } },
            provenance: { source: 'SRD 5.1', ref: 'Evocation' },
          },
        }],
      },
    })).json()).id as number;

    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      const details = page.locator('#character-section-actions');
      // Default state: the panel is collapsed and its contents are not on screen.
      await expect(details.getByRole('button', { name: 'Show details for Scorching Ray' })).toBeVisible();
      await expect(details.getByText('DEX save DC 15')).toBeHidden();

      await page.emulateMedia({ media: 'print' });
      // Same collapsed state, now printing: the details must be on the page.
      await expect(details.getByText('DEX save DC 15')).toBeVisible();
      await expect(details.getByRole('button', { name: 'Show details for Scorching Ray' })).toBeHidden();
      await page.emulateMedia({ media: 'screen' });
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): the roll-mode chooser was gated on
   * `character.actions` alone, so a character whose only attack comes from equipped gear
   * got a rollable chip with no chooser beside it — stuck on Normal unless they happened
   * to find the context menu. The chooser must appear exactly when a rollable chip does.
   */
  test('a gear-only attacker still gets the roll-mode chooser, and it applies', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    // No sheet actions at all — every attack this character has comes from the item.
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Gear Only Attacker', className: 'Fighter', level: 3 },
    })).json()).id as number;

    try {
      const itemId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
        data: { name: 'Loaned Warhammer', qty: 1, ownerType: 'character', characterId },
      })).json()).id as number;
      await ctx.patch(`/api/v1/inventory/${itemId}`, {
        data: {
          equipped: true,
          equipSlot: 'main hand',
          equippedAction: { name: 'Warhammer Swing', kind: 'melee', toHit: '+4', damage: '1d8+2', notes: '', targetAc: '' },
        },
      });

      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      const actions = page.locator('#character-section-actions');
      await expect(actions.getByRole('button', { name: /to hit \+4/ })).toBeVisible();

      const chooser = actions.getByRole('radiogroup', { name: 'Attack roll mode' });
      await expect(chooser).toBeVisible();
      await chooser.getByRole('radio', { name: /Advantage/ }).click();

      // A plain tap now rolls the chosen mode — advantage is two d20s, keep the higher.
      const rolled = page.waitForRequest(
        (req) => req.url().includes(`/campaigns/${campaignId}/roll`) && req.method() === 'POST',
      );
      await actions.getByRole('button', { name: /to hit \+4/ }).click();
      const body = JSON.parse((await rolled).postData() ?? '{}');
      expect(body.expr).toMatch(/2d20kh1/);

      // ...and the context menu's own "Normal" is still an explicit override of it. Both a
      // plain tap and that menu item emit 'normal'; only the tap means "no preference".
      const flat = page.waitForRequest(
        (req) => req.url().includes(`/campaigns/${campaignId}/roll`) && req.method() === 'POST',
      );
      await actions.getByRole('button', { name: /to hit \+4/ }).click({ button: 'right' });
      await page.getByRole('menu').getByRole('menuitem', { name: /Normal/ }).click();
      const flatBody = JSON.parse((await flat).postData() ?? '{}');
      expect(flatBody.expr).not.toMatch(/2d20/);
      // The chooser keeps its selection — the override was for that one roll only.
      await expect(chooser.getByRole('radio', { name: /Advantage/ })).toHaveAttribute('aria-checked', 'true');
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): temp HP writes an ABSOLUTE value read off the
   * current character, so two taps before the refresh landed both PATCHed the same number
   * and one adjustment vanished silently. The control must stay busy until the value it
   * reads has actually refreshed.
   */
  test('the temp HP stepper cannot double-send the same absolute value', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const sent: unknown[] = [];
    // The bug's window is between the PATCH resolving and the REFETCH landing: the control
    // re-enabled there while `character.hpTemp` still held the old value. Delaying the GET
    // (not the PATCH) holds that window open; Playwright's click auto-waits for enabled, so
    // two back-to-back clicks land as early as the implementation allows them to.
    let armed = false;
    await page.route(`**/api/v1/characters/${navigation.characterId}`, async (route) => {
      const method = route.request().method();
      if (method === 'PATCH') {
        sent.push(JSON.parse(route.request().postData() ?? '{}'));
        armed = true;
        return route.fallback();
      }
      if (method === 'GET' && armed) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return route.fallback();
    });

    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);
    const plus = page.getByTestId('character-temp-hp').getByRole('button', { name: /Add 1 temporary hit point/ });
    await expect(page.getByTestId('character-temp-hp-value')).toHaveText('0');

    await plus.click();
    await plus.click();
    await expect(page.getByTestId('character-temp-hp-value')).toHaveText('2');

    // The second tap must have read the REFRESHED value. Sending {hpTemp:1} twice is the
    // defect: two visible taps, one applied, no error shown.
    expect(sent).toEqual([{ hpTemp: 1 }, { hpTemp: 2 }]);

    await page.unroute(`**/api/v1/characters/${navigation.characterId}`);
    const ctx = await request.newContext({ baseURL: new URL(page.url()).origin });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    await ctx.patch(`/api/v1/characters/${navigation.characterId}`, { data: { hpTemp: 0 } });
    await ctx.dispose();
  });

  /**
   * Regression (Codex review on #2115): the parent `load()` catches its own fetch failure
   * and resolves, so awaiting it could not distinguish a refreshed value from a stale one.
   * The write's own response is authoritative, so a broken GET must not strand the stepper
   * on the old number and swallow the next adjustment.
   */
  test('temp HP stays correct even when the follow-up refresh fails', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const sent: unknown[] = [];
    let patched = false;
    await page.route(`**/api/v1/characters/${navigation.characterId}`, async (route) => {
      const method = route.request().method();
      if (method === 'PATCH') {
        sent.push(JSON.parse(route.request().postData() ?? '{}'));
        patched = true;
        return route.fallback();
      }
      // Every refresh AFTER the first write fails outright.
      if (method === 'GET' && patched) return route.abort('failed');
      return route.fallback();
    });

    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);
    const plus = page.getByTestId('character-temp-hp').getByRole('button', { name: /Add 1 temporary hit point/ });
    await expect(page.getByTestId('character-temp-hp-value')).toHaveText('0');

    await plus.click();
    await expect(page.getByTestId('character-temp-hp-value')).toHaveText('1');
    await plus.click();
    await expect(page.getByTestId('character-temp-hp-value')).toHaveText('2');
    expect(sent).toEqual([{ hpTemp: 1 }, { hpTemp: 2 }]);

    await page.unroute(`**/api/v1/characters/${navigation.characterId}`);
    const ctx = await request.newContext({ baseURL: new URL(page.url()).origin });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    await ctx.patch(`/api/v1/characters/${navigation.characterId}`, { data: { hpTemp: 0 } });
    await ctx.dispose();
  });

  /**
   * Regression (Codex review on #2115): `PATCH /characters/:id` writes death-save counters
   * verbatim — unlike the encounter path it does NOT derive `deathState` from them — so an
   * editable pip here could leave three failures sitting at 'dying', on the sheet and in a
   * live fight. The sheet reports the state; the encounter owns the lifecycle.
   */
  test('death saves are reported on the sheet, never edited there', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    const characterId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Down But Not Out', className: 'Cleric', level: 2, hpMax: 12, hpCurrent: 0, deathState: 'dying', deathSaveFailures: 1 },
    })).json()).id as number;

    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}`);
      const panel = page.getByTestId('character-death-saves');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('Death saves — you are dying')).toBeVisible();
      // The state is readable...
      await expect(panel.getByRole('button', { name: 'Failure 1 of 3 (marked)' })).toBeVisible();
      // ...and every pip is inert, so no half-transition can be written from here.
      for (const pip of await panel.getByRole('button').all()) {
        await expect(pip).toBeDisabled();
      }
      await expect(panel.getByRole('button', { name: /Roll a death save/ })).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Copilot review on #2115): the sheet used to fetch the campaign inventory
   * a second time to derive gear actions, duplicating the read the embedded inventory
   * section already makes on mount. One reader, one source.
   */
  test('the sheet reads the campaign inventory once', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const reads: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/api\/v1\/campaigns\/\d+\/inventory(\?|$)/.test(req.url())) reads.push(req.url());
    });

    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);
    await expect(page.getByTestId('character-inventory')).toBeAttached();
    await expect(page.getByRole('heading', { name: 'Actions' })).toBeVisible();
    expect(reads).toHaveLength(1);
  });

  /**
   * Regression (Codex review on #2115): navigating character-to-character without a full
   * reload must never leave the previous character's gear on the new sheet — a player
   * could otherwise see, and roll, an item they do not carry.
   */
  test('navigating to another character does not carry the first one\'s gear over', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });

    const armed = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Carries A Blade', className: 'Fighter', level: 2 },
    })).json()).id as number;
    const empty = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Carries Nothing', className: 'Monk', level: 2 },
    })).json()).id as number;

    try {
      const itemId = (await (await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
        data: { name: 'Borrowed Glaive', qty: 1, ownerType: 'character', characterId: armed },
      })).json()).id as number;
      await ctx.patch(`/api/v1/inventory/${itemId}`, {
        data: {
          equipped: true,
          equipSlot: 'main hand',
          equippedAction: { name: 'Glaive Sweep', kind: 'melee', toHit: '+5', damage: '1d10+3', notes: '', targetAc: '' },
        },
      });

      await page.goto(`/c/${campaignId}/characters/${armed}?tab=play`);
      await expect(page.getByTestId('character-granted-actions').getByText('Glaive Sweep')).toBeVisible();

      // In-app navigation, no reload: the roster link, then the other sheet.
      await page.getByRole('link', { name: /Back to party/ }).click();
      await page.getByRole('link', { name: 'Carries Nothing' }).first().click();
      await expect(page.getByRole('heading', { level: 1, name: 'Carries Nothing' })).toBeVisible();
      await expect(page.getByText('Glaive Sweep')).toHaveCount(0);
      await expect(page.getByTestId('character-granted-actions')).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/v1/characters/${armed}`);
      await ctx.delete(`/api/v1/characters/${empty}`);
      await ctx.dispose();
    }
  });

  /**
   * Regression (Codex review on #2115): the sheet read the pack separately from the
   * embedded inventory section, so unequipping in Build left the granted action still
   * rollable in Play until a full page reload. The two views must move together.
   */
  test('unequipping in Build locks the gear action in Play without a reload', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });

    const characterRes = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
      data: { name: 'Gear Refresh Test', className: 'Fighter', level: 3 },
    });
    expect(characterRes.ok()).toBeTruthy();
    const characterId = (await characterRes.json()).id as number;

    try {
      const itemRes = await ctx.post(`/api/v1/campaigns/${campaignId}/inventory`, {
        data: { name: 'Sunblade', qty: 1, ownerType: 'character', characterId },
      });
      const itemId = (await itemRes.json()).id as number;
      const equipped = await ctx.patch(`/api/v1/inventory/${itemId}`, {
        data: {
          equipped: true,
          equipSlot: 'main hand',
          equippedAction: { name: 'Sunblade Strike', kind: 'melee', toHit: '+7', damage: '1d8+3', notes: '', targetAc: '' },
        },
      });
      expect(equipped.ok()).toBeTruthy();

      await page.goto(`/c/${campaignId}/characters/${characterId}?tab=play`);
      const gear = page.getByTestId('character-granted-actions');
      await expect(gear.getByRole('button', { name: /to hit \+7/ })).toBeVisible();

      await page.getByRole('tab', { name: /Build & profile/ }).click();
      const unequip = page.getByTestId('character-inventory').getByRole('button', { name: 'Unequip Sunblade' });
      await expect(unequip).toBeVisible();
      await unequip.click();

      // Same page, no navigation: the Play action must already reflect the unequip.
      await page.getByRole('tab', { name: /^Play/ }).click();
      await expect(gear.getByText('Equip Sunblade to use this action.')).toBeVisible();
      await expect(gear.getByRole('button', { name: /to hit \+7/ })).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/v1/characters/${characterId}`);
      await ctx.dispose();
    }
  });
});
