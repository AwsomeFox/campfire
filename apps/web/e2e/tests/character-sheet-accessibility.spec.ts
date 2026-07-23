import AxeBuilder from '@axe-core/playwright';
import { expect, request, test } from '@playwright/test';
import { CREDS } from '../global-setup';
import {
  XP_AWARD_HELP,
  XP_AWARD_LABEL,
  hpDeltaLabel,
  hpFullHealLabel,
  saveProficiencyLabel,
  skillProficiencyLabel,
} from '../../src/features/characters/characterSheetA11y';
import { seed, stateFor } from './seed';

/**
 * Issue #448 — name every skill, save, XP, and HP control on the character sheet.
 *
 * Edit mode (owner/DM): unique proficiency names + pressed state, labeled XP
 * award with help/error, contextual HP buttons. Read mode (viewer): axe-clean
 * without edit controls exposing identical “○” names.
 */

test.describe('character sheet accessibility (issue #448)', () => {
  test.describe('edit mode', () => {
    test.use({ storageState: stateFor('player') });

    let characterId = 0;
    const name = `448 A11y PC ${Date.now()}`;

    test.beforeAll(async ({ baseURL }) => {
      const ctx = await request.newContext({ baseURL: baseURL! });
      await ctx.post('/api/v1/auth/login', { data: CREDS.player });
      try {
        const me = await (await ctx.get('/api/v1/me')).json();
        const playerUserId = String(me.user.id);
        const res = await ctx.post(`/api/v1/campaigns/${seed().campaignId}/characters`, {
          data: {
            name,
            className: 'Rogue',
            level: 3,
            ownerUserId: playerUserId,
            ac: 14,
            hpCurrent: 18,
            hpMax: 24,
            xp: 900,
            stats: { STR: 10, DEX: 16, CON: 12, INT: 12, WIS: 14, CHA: 10 },
            saveProficiencies: ['DEX'],
            skills: { Stealth: 'proficient', Perception: 'expertise' },
          },
        });
        if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
        characterId = ((await res.json()) as { id: number }).id;
      } finally {
        await ctx.dispose();
      }
    });

    test.afterAll(async ({ baseURL }) => {
      if (!characterId) return;
      const ctx = await request.newContext({ baseURL: baseURL! });
      await ctx.post('/api/v1/auth/login', { data: CREDS.dm });
      try {
        await ctx.delete(`/api/v1/characters/${characterId}`);
      } finally {
        await ctx.dispose();
      }
    });

    test('names save/skill/XP/HP controls, announces XP errors, and is axe-clean', async ({ page }) => {
      const { campaignId } = seed();
      await page.goto(`/c/${campaignId}/characters/${characterId}`);
      await expect(page.getByRole('heading', { name })).toBeVisible();

      const saves = page.locator('section', { hasText: 'Saving throws' }).first();
      const dexSaveProf = saves.getByRole('button', { name: saveProficiencyLabel('DEX', true) });
      await expect(dexSaveProf).toBeVisible();
      await expect(dexSaveProf).toHaveAttribute('aria-pressed', 'true');
      const strSaveProf = saves.getByRole('button', { name: saveProficiencyLabel('STR', false) });
      await expect(strSaveProf).toBeVisible();
      await expect(strSaveProf).toHaveAttribute('aria-pressed', 'false');
      // Glyph-only names must not be the accessible name.
      await expect(saves.getByRole('button', { name: '○', exact: true })).toHaveCount(0);

      const skills = page.locator('section', { hasText: 'Skills' }).first();
      await expect(
        skills.getByRole('button', { name: skillProficiencyLabel('Stealth', 'proficient') }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        skills.getByRole('button', { name: skillProficiencyLabel('Perception', 'expertise') }),
      ).toBeVisible();
      await expect(
        skills.getByRole('button', { name: skillProficiencyLabel('Athletics', 'none') }),
      ).toHaveAttribute('aria-pressed', 'false');

      const xp = page.getByRole('textbox', { name: XP_AWARD_LABEL });
      await expect(xp).toBeVisible();
      await expect(xp).toHaveAccessibleDescription(XP_AWARD_HELP);
      await xp.fill('0');
      await page.getByRole('button', { name: '+ Award XP' }).click();
      await expect(page.getByRole('alert').filter({ hasText: /other than 0/i })).toBeVisible();
      await expect(xp).toHaveAttribute('aria-invalid', 'true');
      await expect(xp).toHaveAccessibleDescription(/other than 0/i);

      const hpGroup = page.getByRole('group', { name: `${name} hit points` });
      await expect(
        hpGroup.getByRole('button', { name: hpDeltaLabel(name, -1, 18, 24) }),
      ).toBeVisible();
      await expect(
        hpGroup.getByRole('button', { name: hpFullHealLabel(name, 24) }),
      ).toBeVisible();

      // Logical focus: labeled HP controls remain focusable by name.
      await hpGroup.getByRole('button', { name: hpDeltaLabel(name, 1, 18, 24) }).focus();
      await expect(hpGroup.getByRole('button', { name: hpDeltaLabel(name, 1, 18, 24) })).toBeFocused();

      // Scope to the controls this issue names (theme-wide slate contrast is out of scope).
      for (const testId of [
        'character-saving-throws',
        'character-skills',
        'character-xp',
        'character-hp-editor',
      ]) {
        const scan = await new AxeBuilder({ page })
          .include(`[data-testid="${testId}"]`)
          .disableRules(['color-contrast'])
          .analyze();
        expect(scan.violations, testId).toEqual([]);
      }
    });
  });

  test.describe('read mode', () => {
    test.use({ storageState: stateFor('viewer') });

    test('read-only sheet keeps roll names unique and is axe-clean', async ({ page }) => {
      const { campaignId, navigation } = seed();
      await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

      // Viewers must not see proficiency toggles (glyph-only ○ buttons).
      await expect(page.getByRole('button', { name: '○', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Roll STR save/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Roll Athletics/i })).toBeVisible();
      await expect(page.getByRole('textbox', { name: XP_AWARD_LABEL })).toHaveCount(0);

      for (const testId of ['character-saving-throws', 'character-skills']) {
        const scan = await new AxeBuilder({ page })
          .include(`[data-testid="${testId}"]`)
          .disableRules(['color-contrast'])
          .analyze();
        expect(scan.violations, testId).toEqual([]);
      }
    });
  });
});
