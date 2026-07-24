import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  FACTION_EDITOR_ID_PREFIX,
  FACTION_FIELD_NAMES,
  NPC_EDITOR_ID_PREFIX,
  NPC_FIELD_NAMES,
  labeledFieldIds,
} from '../../src/components/LabeledField';
import { seed, stateFor } from './seed';

/**
 * Issue #777 — NPC and Faction editors: every visible label associates with its
 * control, fields expose explicit names, and DM-only privacy is grouped.
 */

test.describe('NPC editor labeled fields', () => {
  test.use({ storageState: stateFor('dm') });

  test('associates labels, names controls, and groups DM privacy', async ({ page }) => {
    const { campaignId, npcId } = seed();
    await page.goto(`/c/${campaignId}/npcs/${npcId}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();

    const editor = page.getByRole('region', { name: 'Edit NPC' });
    await expect(editor).toBeVisible();

    const nameIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.name);
    const roleIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.role);
    const dispositionIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.disposition);
    const locationIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.locationId);
    const factionIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.factionId);
    const bodyIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.body);
    const secretIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.dmSecret);
    const hiddenIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.hidden);

    const nameField = editor.getByRole('textbox', { name: 'Name' });
    const roleField = editor.getByRole('textbox', { name: 'Role' });
    const dispositionField = editor.getByRole('textbox', { name: 'Disposition' });
    const locationField = editor.getByRole('combobox', { name: 'Location' });
    const factionField = editor.getByRole('combobox', { name: 'Faction' });
    const bodyField = editor.getByRole('textbox', { name: 'Description (markdown)' });
    const secretField = editor.getByRole('textbox', { name: /DM secret/ });
    const hiddenField = editor.getByRole('checkbox', { name: /Hidden from players \(whole NPC/ });

    await expect(nameField).toHaveAttribute('id', nameIds.controlId);
    await expect(nameField).toHaveAttribute('name', NPC_FIELD_NAMES.name);
    await expect(roleField).toHaveAttribute('name', NPC_FIELD_NAMES.role);
    await expect(dispositionField).toHaveAttribute('name', NPC_FIELD_NAMES.disposition);
    await expect(locationField).toHaveAttribute('id', locationIds.controlId);
    await expect(locationField).toHaveAttribute('name', NPC_FIELD_NAMES.locationId);
    await expect(factionField).toHaveAttribute('name', NPC_FIELD_NAMES.factionId);
    await expect(bodyField).toHaveAttribute('id', bodyIds.controlId);
    await expect(bodyField).toHaveAttribute('name', NPC_FIELD_NAMES.body);
    await expect(secretField).toHaveAttribute('id', secretIds.controlId);
    await expect(secretField).toHaveAttribute('name', NPC_FIELD_NAMES.dmSecret);
    await expect(hiddenField).toHaveAttribute('id', hiddenIds.controlId);
    await expect(hiddenField).toHaveAttribute('name', NPC_FIELD_NAMES.hidden);

    // Label activation: clicking a <label> focuses its associated control.
    await editor.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(nameField).toBeFocused();
    await editor.locator(`label[for="${roleIds.controlId}"]`).click();
    await expect(roleField).toBeFocused();
    await editor.locator(`label[for="${dispositionIds.controlId}"]`).click();
    await expect(dispositionField).toBeFocused();
    await editor.locator(`label[for="${locationIds.controlId}"]`).click();
    await expect(locationField).toBeFocused();
    await editor.locator(`label[for="${factionIds.controlId}"]`).click();
    await expect(factionField).toBeFocused();
    await editor.locator(`label[for="${bodyIds.controlId}"]`).click();
    await expect(bodyField).toBeFocused();
    await editor.locator(`label[for="${secretIds.controlId}"]`).click();
    await expect(secretField).toBeFocused();
    await editor.locator(`label[for="${hiddenIds.controlId}"]`).click();
    await expect(hiddenField).toBeFocused();

    const privacy = editor.getByRole('group', { name: /DM-only privacy/ });
    await expect(privacy).toBeVisible();
    await expect(privacy).toContainText(/private field content/i);
    await expect(privacy).toContainText(/whole entity/i);
    await expect(secretField).toHaveAccessibleDescription(/Secret-field privacy/i);

    // Label/name semantics only — shared cf-btn contrast on dark cards is out of scope for #777.
    const a11y = await new AxeBuilder({ page })
      .include('[aria-label="Edit NPC"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(a11y.violations).toEqual([]);

    await editor.getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('NPC proposal mode preserves field names', () => {
  test.use({ storageState: stateFor('player') });

  test('keeps the same accessible names and ids without DM privacy controls', async ({ page }) => {
    const { campaignId, npcId } = seed();
    await page.goto(`/c/${campaignId}/npcs/${npcId}`);
    await page.getByRole('button', { name: '✎ Suggest an edit' }).click();

    const editor = page.getByRole('region', { name: 'Suggest NPC edit' });
    await expect(editor).toBeVisible();

    const nameIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.name);
    const bodyIds = labeledFieldIds(NPC_EDITOR_ID_PREFIX, NPC_FIELD_NAMES.body);
    const nameField = editor.getByRole('textbox', { name: 'Name' });
    const bodyField = editor.getByRole('textbox', { name: 'Description (markdown)' });

    await expect(nameField).toHaveAttribute('id', nameIds.controlId);
    await expect(nameField).toHaveAttribute('name', NPC_FIELD_NAMES.name);
    await expect(bodyField).toHaveAttribute('id', bodyIds.controlId);
    await expect(bodyField).toHaveAttribute('name', NPC_FIELD_NAMES.body);
    await expect(editor.getByRole('combobox', { name: 'Location' })).toHaveAttribute(
      'name',
      NPC_FIELD_NAMES.locationId,
    );
    await expect(editor.getByRole('group', { name: /DM-only privacy/ })).toHaveCount(0);
    await expect(editor.getByRole('textbox', { name: /DM secret/ })).toHaveCount(0);

    await editor.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(nameField).toBeFocused();

    await editor.getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('Faction editor labeled fields', () => {
  test.use({ storageState: stateFor('dm') });

  test('associates labels for text, numeric, select, and textarea fields', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/factions/${navigation.factionId}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();

    const editor = page.getByRole('region', { name: 'Edit faction' });
    await expect(editor).toBeVisible();

    const nameIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.name);
    const kindIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.kind);
    const standingIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.standing);
    const reputationIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.reputation);
    const bodyIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.body);
    const goalsIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.goals);
    const secretIds = labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.dmSecret);

    const nameField = editor.getByRole('textbox', { name: 'Name' });
    const kindField = editor.getByRole('textbox', { name: 'Kind' });
    const standingField = editor.getByRole('combobox', { name: 'Standing' });
    const reputationField = editor.getByRole('spinbutton', { name: /Reputation/ });
    const bodyField = editor.getByRole('textbox', { name: 'Description (markdown)' });
    const goalsField = editor.getByRole('textbox', { name: /Goals \(markdown\)/ });
    const secretField = editor.getByRole('textbox', { name: /DM secret/ });

    await expect(nameField).toHaveAttribute('id', nameIds.controlId);
    await expect(nameField).toHaveAttribute('name', FACTION_FIELD_NAMES.name);
    await expect(kindField).toHaveAttribute('name', FACTION_FIELD_NAMES.kind);
    await expect(standingField).toHaveAttribute('id', standingIds.controlId);
    await expect(standingField).toHaveAttribute('name', FACTION_FIELD_NAMES.standing);
    await expect(reputationField).toHaveAttribute('type', 'number');
    await expect(reputationField).toHaveAttribute('id', reputationIds.controlId);
    await expect(reputationField).toHaveAttribute('name', FACTION_FIELD_NAMES.reputation);
    await expect(reputationField).toHaveAccessibleDescription(/−100 to 100/i);
    await expect(bodyField).toHaveAttribute('name', FACTION_FIELD_NAMES.body);
    await expect(goalsField).toHaveAttribute('id', goalsIds.controlId);
    await expect(goalsField).toHaveAttribute('name', FACTION_FIELD_NAMES.goals);
    await expect(secretField).toHaveAttribute('name', FACTION_FIELD_NAMES.dmSecret);

    await editor.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(nameField).toBeFocused();
    await editor.locator(`label[for="${kindIds.controlId}"]`).click();
    await expect(kindField).toBeFocused();
    await editor.locator(`label[for="${standingIds.controlId}"]`).click();
    await expect(standingField).toBeFocused();
    await editor.locator(`label[for="${reputationIds.controlId}"]`).click();
    await expect(reputationField).toBeFocused();
    await editor.locator(`label[for="${bodyIds.controlId}"]`).click();
    await expect(bodyField).toBeFocused();
    await editor.locator(`label[for="${goalsIds.controlId}"]`).click();
    await expect(goalsField).toBeFocused();
    await editor.locator(`label[for="${secretIds.controlId}"]`).click();
    await expect(secretField).toBeFocused();

    await expect(editor.getByRole('group', { name: /DM-only privacy/ })).toBeVisible();
    await expect(editor.getByRole('checkbox', { name: /Hidden from players \(whole faction/ })).toBeVisible();

    // Invalid state: force a field-level validation error onto reputation.
    await page.route(`**/api/v1/factions/${navigation.factionId}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Validation failed',
          errors: [{ path: ['reputation'], message: 'Reputation must be between -100 and 100.' }],
        }),
      });
    });
    await nameField.fill('Labeled faction');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(reputationField).toHaveAttribute('aria-invalid', 'true');
    await expect(reputationField).toHaveAccessibleDescription(/Reputation must be between/i);
    await expect(editor.locator('#faction-editor-reputation-error')).toHaveText(
      /Reputation must be between -100 and 100/i,
    );
    await expect(editor.locator('#faction-editor-form-error')).toContainText(/Reputation/i);

    const a11y = await new AxeBuilder({ page })
      .include('[aria-label="Edit faction"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(a11y.violations).toEqual([]);

    await editor.getByRole('button', { name: 'Cancel' }).click();
  });
});
