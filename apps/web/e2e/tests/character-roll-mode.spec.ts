import AxeBuilder from '@axe-core/playwright';
import { test, expect, request } from '@playwright/test';
import { seed, stateFor } from './seed';
import { CREDS } from '../global-setup';

/**
 * Issue #713 — expose Flat / Advantage / Disadvantage at the character-sheet roll
 * controls for touch AND keyboard (saving throws, skills, attack "to hit").
 *
 * Covers the acceptance criteria end-to-end:
 *  - The chooser is visible on a touch viewport (no hover available).
 *  - Selecting Advantage via the chooser shows the mode before submission.
 *  - The roll that follows reflects it (the posted expression becomes 2d20kh1…).
 *  - The keyboard-modifier shortcut still overrides the chooser for one roll.
 *  - The chooser is keyboard-operable (radiogroup arrow navigation) and axe-clean.
 *
 * Uses its own freshly-created character (saves/skills are always present on a
 * sheet; an attack action is added so the Actions chooser is exercised too) so
 * the shared seeded roster stays untouched.
 */

test.describe('Character sheet roll-mode chooser (issue #713)', () => {
  test.use({ storageState: stateFor('player') });

  let characterId = 0;
  const name = `713 Roll-mode PC ${Date.now()}`;

  test.beforeAll(async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.player });
    try {
      const me = await (await ctx.get('/api/v1/me')).json();
      const playerUserId = String(me.user.id);
      const res = await ctx.post(`/api/v1/campaigns/${seed().campaignId}/characters`, {
        data: {
          name,
          className: 'Fighter',
          level: 5,
          ownerUserId: playerUserId,
          ac: 16,
          hpCurrent: 30,
          hpMax: 30,
          stats: { STR: 18, DEX: 14, CON: 16, INT: 10, WIS: 12, CHA: 8 },
          saveProficiencies: ['STR'],
          skills: { Athletics: 'proficient' },
          actions: [{ name: 'Longsword', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', notes: '' }],
        },
      });
      if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
      const body = await res.json();
      characterId = body.id as number;
    } finally {
      await ctx.dispose();
    }
  });

  test.afterAll(async ({ baseURL }) => {
    if (!characterId) return;
    const ctx = await request.newContext({ baseURL: baseURL! });
    await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
    try {
      // Hard-delete keeps the shared roster pristine across runs.
      await ctx.delete(`/api/v1/characters/${characterId}`);
    } finally {
      await ctx.dispose();
    }
  });

  test('a touch user picks advantage from the chooser and the save roll reflects it', async ({ page }) => {
    const { campaignId } = seed();
    // A narrow mobile viewport — hover titles are not reachable here, so this is
    // exactly the touch-user population that could previously only flat-roll.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    const chooser = page.getByRole('radiogroup', { name: 'Saving throw roll mode' });
    await expect(chooser).toBeVisible();

    // Default is Flat; the live status (role=status) announces it before any roll.
    // The chooser and its status live in the same Saving throws card.
    const savesCard = page.locator('section', { hasText: 'Saving throws' }).first();
    await expect(savesCard.getByRole('status')).toContainText(/flat roll/i);

    // Select Advantage via the visible chooser (a tap, not a modifier key).
    await chooser.getByRole('radio', { name: /advantage/i }).click();
    await expect(savesCard.getByRole('status')).toContainText(/rolling with advantage/i);
    // The selected option reports its state accessibly.
    await expect(chooser.getByRole('radio', { name: /advantage/i })).toHaveAttribute('aria-checked', 'true');

    // The STR save button now advertises the advantage mode in its accessible name.
    const strSave = savesCard.getByRole('button', { name: /Roll STR save.*advantage/i });
    await expect(strSave).toBeVisible();

    // Rolling posts 2d20kh1… to the shared dice log — assert on the request.
    const [rollRequest] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/v1/campaigns/${campaignId}/roll`) && res.request().method() === 'POST',
      ),
      strSave.click(),
    ]);
    expect(rollRequest.status()).toBeLessThan(300);
    const posted = rollRequest.request().postDataJSON() as { expr: string; label: string };
    // Advantage expression is 2d20kh1 + modifier (the keep-higher dice grammar).
    expect(posted.expr).toMatch(/^2d20kh1/);
    expect(posted.label).toContain('STR save');
  });

  test('the keyboard shortcut still overrides the chooser for a single roll', async ({ page }) => {
    const { campaignId } = seed();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    const chooser = page.getByRole('radiogroup', { name: 'Saving throw roll mode' });
    const savesCard = page.locator('section', { hasText: 'Saving throws' }).first();

    // Leave the chooser on Flat (the default).
    await expect(chooser.getByRole('radio', { name: /^flat/i })).toHaveAttribute('aria-checked', 'true');

    // Shift-click the DEX save — advantage applies THIS roll only, even though
    // the chooser still reads Flat afterward.
    const dexSave = savesCard.getByRole('button', { name: /Roll DEX save/i });
    const [rollRequest] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(`/api/v1/campaigns/${campaignId}/roll`) && res.request().method() === 'POST',
      ),
      dexSave.click({ modifiers: ['Shift'] }),
    ]);
    const posted = rollRequest.request().postDataJSON() as { expr: string };
    expect(posted.expr).toMatch(/^2d20kh1/);

    // The chooser selection is untouched — the shortcut was a one-shot override.
    await expect(chooser.getByRole('radio', { name: /^flat/i })).toHaveAttribute('aria-checked', 'true');
  });

  test('the chooser is keyboard-operable (arrow keys move and select) and axe-clean', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    const chooser = page.getByRole('radiogroup', { name: 'Saving throw roll mode' });
    // Enter the group on the (tabindex 0) selected Flat option.
    await chooser.getByRole('radio', { name: /^flat/i }).focus();
    // ArrowRight moves to Advantage AND selects it (radiogroup semantics).
    await page.keyboard.press('ArrowRight');
    await expect(chooser.getByRole('radio', { name: /advantage/i })).toHaveAttribute('aria-checked', 'true');
    await expect(chooser.getByRole('radio', { name: /advantage/i })).toBeFocused();
    // ArrowRight again lands on Disadvantage.
    await page.keyboard.press('ArrowRight');
    await expect(chooser.getByRole('radio', { name: /disadvantage/i })).toHaveAttribute('aria-checked', 'true');

    // No axe violations scoped to the chooser (names, roles, keyboard).
    const results = await new AxeBuilder({ page })
      .include('.cf-roll-mode')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
