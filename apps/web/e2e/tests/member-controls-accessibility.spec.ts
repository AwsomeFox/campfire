import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  ADD_MEMBER_CANCEL_LABEL,
  ADD_MEMBER_ROLE_LABEL,
  ADD_MEMBER_SEARCH_LABEL,
  MEMBER_CHARACTER_LINK_HELP,
  memberCharacterControlLabel,
  memberRoleControlLabel,
} from '../../src/features/admin/memberControlsA11y';
import { seed, stateFor } from './seed';

/**
 * Issue #451 — member-specific accessible names for role/character controls,
 * ownership-vs-seat guidance, add-member dialog focus, and save announcements.
 */

test.describe('campaign member controls accessibility (issue #451)', () => {
  test.use({ storageState: stateFor('dm') });

  test('add-member dialog focuses Cancel, names the role control, and is axe-clean', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/members`);

    const card = page.getByTestId('members-card');
    await expect(card).toBeVisible();

    const open = card.getByRole('button', { name: '+ Add member' });
    await open.click();

    const dialog = page.getByTestId('add-member-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog.getByRole('button', { name: ADD_MEMBER_CANCEL_LABEL })).toBeFocused();

    const role = dialog.getByLabel(ADD_MEMBER_ROLE_LABEL);
    await expect(role).toBeVisible();
    await expect(role).toHaveAccessibleDescription(/DM runs the table/i);
    await expect(dialog.getByLabel(ADD_MEMBER_SEARCH_LABEL)).toBeVisible();

    const dialogScan = await new AxeBuilder({ page })
      .include('[data-testid="add-member-dialog"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(dialogScan.violations).toEqual([]);

    await dialog.getByRole('button', { name: ADD_MEMBER_CANCEL_LABEL }).click();
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test('member rows expose person-specific role/character names and linkage help', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/members`);

    const rows = page.getByTestId('members-rows');
    await expect(rows).toBeVisible();

    // Seeded roster includes dm / player / viewer (usernames double as labels).
    for (const who of ['dm', 'player', 'viewer'] as const) {
      const role = rows.getByLabel(memberRoleControlLabel(who));
      const character = rows.getByLabel(memberCharacterControlLabel(who));
      await expect(role).toBeVisible();
      await expect(character).toBeVisible();
      await expect(character).toHaveAccessibleDescription(MEMBER_CHARACTER_LINK_HELP);
    }

    // Changing player's role announces the save (polite live region).
    const playerRole = rows.getByLabel(memberRoleControlLabel('player'));
    await playerRole.selectOption('viewer');
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: /Role for player saved as Viewer/i })).toBeAttached();

    // Restore so later tests keep the seeded role.
    await playerRole.selectOption('player');
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: /Role for player saved as Player/i })).toBeAttached();

    const rowsScan = await new AxeBuilder({ page })
      .include('[data-testid="members-rows"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(rowsScan.violations).toEqual([]);
  });
});
