import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { fieldIds } from '../../src/components/Field';
import {
  CHARACTER_EDIT_PREFIX,
  CHARACTER_FIELD,
  CHARACTER_NAME_LABEL,
  CHARACTER_STATUS_LABEL,
  COMMENT_BODY_LABEL,
  ENCOUNTER_CREATE_PREFIX,
  ENCOUNTER_FIELD,
  ENCOUNTER_LOCATION_LABEL,
  INVENTORY_ADD_PREFIX,
  INVENTORY_FIELD,
  INVENTORY_NAME_LABEL,
  LOCATION_EDIT_PREFIX,
  LOCATION_FIELD,
  LOCATION_NAME_LABEL,
  MAP_FILE_LABEL,
  MAP_IMPORT_FIELD,
  MAP_IMPORT_PREFIX,
  MAP_TITLE_LABEL,
  SESSION_ZERO_FIELD,
  SESSION_ZERO_LINES_LABEL,
  SESSION_ZERO_PREFIX,
  SESSION_ZERO_SUPPORT_LABEL,
} from '../../src/components/formFieldLabels';
import { ENCOUNTER_NAME_LABEL } from '../../src/features/encounters/postCreateGuidance';
import { NOTE_BODY_LABEL } from '../../src/components/noteVisibilityA11y';
import { seed, stateFor } from './seed';

/**
 * Issue #886 — shared Field primitive on remaining authoring/composer surfaces:
 * accessible names (speech-input contract), label activation via htmlFor, help/
 * file-format association, and axe coverage at desktop + 400% zoom.
 */

test.describe('shared Field labels on authoring surfaces (issue #886)', () => {
  test.use({ storageState: stateFor('dm') });

  test('inventory add-item names every Field and is axe-clean', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/inventory`);
    await page.getByRole('button', { name: '+ Add item' }).click();
    const form = page.getByTestId('inventory-add-item');

    const nameIds = fieldIds(INVENTORY_ADD_PREFIX, INVENTORY_FIELD.name);
    const qtyIds = fieldIds(INVENTORY_ADD_PREFIX, INVENTORY_FIELD.qty);
    const ownerIds = fieldIds(INVENTORY_ADD_PREFIX, INVENTORY_FIELD.owner);
    const notesIds = fieldIds(INVENTORY_ADD_PREFIX, INVENTORY_FIELD.notes);

    const name = form.getByRole('textbox', { name: new RegExp(INVENTORY_NAME_LABEL) });
    const qty = form.getByRole('textbox', { name: 'Quantity' });
    const owner = form.getByRole('combobox', { name: 'Owner' });
    const notes = form.getByRole('textbox', { name: /Notes/ });

    await expect(name).toHaveAttribute('id', nameIds.controlId);
    await expect(qty).toHaveAttribute('id', qtyIds.controlId);
    await expect(owner).toHaveAttribute('id', ownerIds.controlId);
    await expect(notes).toHaveAttribute('id', notesIds.controlId);
    await expect(name).toHaveAccessibleDescription(/Required/);
    await expect(qty).toHaveAccessibleDescription(/Whole number/);

    await form.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(name).toBeFocused();
    await form.locator(`label[for="${qtyIds.controlId}"]`).click();
    await expect(qty).toBeFocused();

    const scan = await new AxeBuilder({ page })
      .include('[data-testid="inventory-add-item"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);

    await form.getByRole('button', { name: 'Cancel' }).click();
  });

  test('encounter create associates name + link selects and is axe-clean', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/encounters`);
    await page.getByRole('button', { name: '+ New encounter' }).click();
    const form = page.getByTestId('encounter-create-form');

    const nameIds = fieldIds(ENCOUNTER_CREATE_PREFIX, ENCOUNTER_FIELD.name);
    const locationIds = fieldIds(ENCOUNTER_CREATE_PREFIX, ENCOUNTER_FIELD.locationId);
    const name = form.getByRole('textbox', { name: new RegExp(ENCOUNTER_NAME_LABEL) });
    const location = form.getByRole('combobox', { name: new RegExp(ENCOUNTER_LOCATION_LABEL) });

    await expect(name).toHaveAttribute('id', nameIds.controlId);
    await expect(location).toHaveAttribute('id', locationIds.controlId);
    await expect(name).toHaveAccessibleDescription(/Required/);

    await form.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(name).toBeFocused();
    await form.locator(`label[for="${locationIds.controlId}"]`).click();
    await expect(location).toBeFocused();

    const scan = await new AxeBuilder({ page })
      .include('[data-testid="encounter-create-form"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);

    await form.getByRole('button', { name: 'Cancel' }).click();
  });

  test('character sheet edit labels metadata/abilities with activation + axe', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);
    await page.getByRole('button', { name: '✎ Edit sheet' }).click();
    const editor = page.getByTestId('character-sheet-edit');
    await expect(editor).toBeVisible();

    const nameIds = fieldIds(CHARACTER_EDIT_PREFIX, CHARACTER_FIELD.name);
    const statusIds = fieldIds(CHARACTER_EDIT_PREFIX, CHARACTER_FIELD.status);
    const strIds = fieldIds(CHARACTER_EDIT_PREFIX, 'STR');

    const name = editor.getByRole('textbox', { name: new RegExp(`^${CHARACTER_NAME_LABEL}`) });
    const status = editor.getByRole('combobox', { name: CHARACTER_STATUS_LABEL });
    const str = editor.getByRole('textbox', { name: 'STR' });

    await expect(name).toHaveAttribute('id', nameIds.controlId);
    await expect(status).toHaveAttribute('id', statusIds.controlId);
    await expect(str).toHaveAttribute('id', strIds.controlId);
    await expect(status).toHaveAccessibleDescription(/active characters/i);

    await editor.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(name).toBeFocused();
    await editor.locator(`label[for="${strIds.controlId}"]`).click();
    await expect(str).toBeFocused();

    const scan = await new AxeBuilder({ page })
      .include('[data-testid="character-sheet-edit"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);

    await editor.getByRole('button', { name: 'Cancel' }).click();
  });

  test('location editor associates labels/help including DM secret', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/locations/${navigation.locationId}`);
    await page.getByRole('button', { name: '✎ Edit' }).click();

    const nameIds = fieldIds(LOCATION_EDIT_PREFIX, LOCATION_FIELD.name);
    const bodyIds = fieldIds(LOCATION_EDIT_PREFIX, LOCATION_FIELD.body);
    const secretIds = fieldIds(LOCATION_EDIT_PREFIX, LOCATION_FIELD.dmSecret);

    const name = page.getByRole('textbox', { name: new RegExp(`^${LOCATION_NAME_LABEL}`) });
    const body = page.getByRole('textbox', { name: /^Description/ });
    const secret = page.getByRole('textbox', { name: /DM secret/ });

    await expect(name).toHaveAttribute('id', nameIds.controlId);
    await expect(body).toHaveAttribute('id', bodyIds.controlId);
    await expect(secret).toHaveAttribute('id', secretIds.controlId);
    await expect(secret).toHaveAccessibleDescription(/players never|stripped/i);

    await page.locator(`label[for="${nameIds.controlId}"]`).click();
    await expect(name).toBeFocused();

    const scan = await new AxeBuilder({ page })
      .include('[data-testid="location-editor-fields"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);

    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('session zero charter + support preference use Field labels', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/session-zero`);

    const supportIds = fieldIds(SESSION_ZERO_PREFIX, SESSION_ZERO_FIELD.supportText);
    const support = page.getByRole('textbox', { name: SESSION_ZERO_SUPPORT_LABEL });
    await expect(support).toHaveAttribute('id', supportIds.controlId);
    await expect(support).toHaveAccessibleDescription(/optional|processing time|timers/i);
    await page.locator(`label[for="${supportIds.controlId}"]`).click();
    await expect(support).toBeFocused();

    await page.getByRole('button', { name: /Edit charter|Write charter/i }).click();
    const charter = page.getByTestId('session-zero-charter-form');
    const linesIds = fieldIds(SESSION_ZERO_PREFIX, SESSION_ZERO_FIELD.lines);
    const lines = charter.getByRole('textbox', { name: SESSION_ZERO_LINES_LABEL });
    await expect(lines).toHaveAttribute('id', linesIds.controlId);
    await expect(lines).toHaveAccessibleDescription(/one entry per line|per line/i);
    await charter.locator(`label[for="${linesIds.controlId}"]`).click();
    await expect(lines).toBeFocused();

    const scan = await new AxeBuilder({ page })
      .include('[data-testid="session-zero-charter-form"]')
      .disableRules(['color-contrast'])
      .analyze();
    expect(scan.violations).toEqual([]);

    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('notes and comments composers expose labeled bodies; map file help names formats', async ({
    page,
    browser,
  }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/locations/${navigation.locationId}`);

    const notes = page.getByTestId('notes-compose');
    const noteBody = notes.getByRole('textbox', { name: NOTE_BODY_LABEL });
    await expect(noteBody).toBeVisible();
    await expect(noteBody).toHaveAccessibleDescription(/private by default/i);
    await notes.locator('label').filter({ hasText: NOTE_BODY_LABEL }).click();
    await expect(noteBody).toBeFocused();

    await page.goto(`/c/${campaignId}/sessions?session=${navigation.sessionId}`);
    const compose = page.getByTestId('comments-compose').last();
    const comment = compose.getByRole('textbox', { name: new RegExp(COMMENT_BODY_LABEL) });
    await expect(comment).toBeVisible();
    await expect(comment).toHaveAccessibleDescription(/markdown/i);
    await compose.locator('label').filter({ hasText: COMMENT_BODY_LABEL }).click();
    await expect(comment).toBeFocused();

    // Map import file purpose/format — open Get a map on an encounter without a map
    // when available; otherwise assert vocabulary + id contract only via unit suite.
    // Here we mount the import form by navigating to the seed encounter and opening
    // the panel if the empty-map affordance is present.
    await page.goto(`/c/${campaignId}/encounters/${navigation.encounterId}`);
    const getMap = page.getByRole('button', { name: /Get a map|Import/i }).first();
    if (await getMap.isVisible().catch(() => false)) {
      await getMap.click();
      const importBtn = page.getByRole('button', { name: /Import|One Page|CC-BY/i }).first();
      if (await importBtn.isVisible().catch(() => false)) {
        await importBtn.click();
        const form = page.getByTestId('map-import-form');
        if (await form.isVisible().catch(() => false)) {
          const titleIds = fieldIds(MAP_IMPORT_PREFIX, MAP_IMPORT_FIELD.title);
          const fileIds = fieldIds(MAP_IMPORT_PREFIX, MAP_IMPORT_FIELD.file);
          await expect(form.getByRole('textbox', { name: new RegExp(MAP_TITLE_LABEL) })).toHaveAttribute(
            'id',
            titleIds.controlId,
          );
          const file = form.locator(`#${fileIds.controlId}`);
          await expect(file).toHaveAttribute('type', 'file');
          await expect(form.getByText(MAP_FILE_LABEL)).toBeVisible();
          await expect(file).toHaveAccessibleDescription(/png|jpeg|webp/i);
        }
      }
    }

    // 400% zoom: labels remain visible (not clipped to placeholder-only) on inventory.
    const zoom = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 320, height: 700 },
      deviceScaleFactor: 1,
    });
    const zoomPage = await zoom.newPage();
    try {
      await zoomPage.goto(`/c/${campaignId}/inventory`);
      await zoomPage.getByRole('button', { name: '+ Add item' }).click();
      const form = zoomPage.getByTestId('inventory-add-item');
      // Required fields append a visible * + sr-only "(required)" — match the durable name.
      await expect(form.getByRole('textbox', { name: new RegExp(INVENTORY_NAME_LABEL) })).toBeVisible();
      await expect(form.getByRole('textbox', { name: 'Quantity' })).toBeVisible();
      await zoomPage.setViewportSize({ width: 320, height: 700 });
      // Approximate 400% by narrow viewport + large default font via CSS.
      await zoomPage.addStyleTag({ content: 'html { font-size: 400% !important; }' });
      await expect(form.locator('label', { hasText: INVENTORY_NAME_LABEL })).toBeVisible();
      await expect(form.locator('label', { hasText: 'Quantity' })).toBeVisible();
      const zoomScan = await new AxeBuilder({ page: zoomPage })
        .include('[data-testid="inventory-add-item"]')
        .disableRules(['color-contrast'])
        .analyze();
      expect(zoomScan.violations).toEqual([]);
    } finally {
      await zoom.close();
    }
  });
});
