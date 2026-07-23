import { expect, test } from '@playwright/test';
import { describedByFor, fieldIds, sanitizeFieldPrefix } from '../../src/components/Field';
import {
  AI_TABLE_FIELD,
  AI_TABLE_PREFIX,
  CHARACTER_AC_LABEL,
  CHARACTER_EDIT_PREFIX,
  CHARACTER_FIELD,
  CHARACTER_HP_MAX_HELP,
  CHARACTER_NAME_LABEL,
  CHARACTER_STATUS_HELP,
  COMMENT_BODY_LABEL,
  COMMENTS_COMPOSE_PREFIX,
  ENCOUNTER_CREATE_PREFIX,
  ENCOUNTER_FIELD,
  INVENTORY_ADD_PREFIX,
  INVENTORY_FIELD,
  INVENTORY_NAME_LABEL,
  LOCATION_DM_SECRET_HELP,
  LOCATION_EDIT_PREFIX,
  LOCATION_FIELD,
  MAP_FILE_ACCEPT,
  MAP_FILE_HELP,
  MAP_FILE_LABEL,
  MAP_IMPORT_FIELD,
  MAP_IMPORT_PREFIX,
  MAP_TITLE_LABEL,
  NOTES_COMPOSE_PREFIX,
  NOTES_FIELD,
  SESSION_ZERO_FIELD,
  SESSION_ZERO_LINES_HELP,
  SESSION_ZERO_PREFIX,
  SESSION_ZERO_SUPPORT_LABEL,
} from '../../src/components/formFieldLabels';
import { ENCOUNTER_NAME_ID } from '../../src/features/encounters/postCreateGuidance';
import { NOTE_BODY_LABEL } from '../../src/components/noteVisibilityA11y';

/**
 * Issue #886 — shared Field primitive id/help/error contract + vocabulary for
 * remaining authoring/composer surfaces.
 */

test.describe('fieldIds (issue #886)', () => {
  test('builds stable control/help/error ids from prefix + name', () => {
    expect(fieldIds('character-edit', 'name')).toEqual({
      controlId: 'character-edit-name',
      helpId: 'character-edit-name-help',
      errorId: 'character-edit-name-error',
    });
    expect(fieldIds(MAP_IMPORT_PREFIX, MAP_IMPORT_FIELD.file)).toEqual({
      controlId: 'map-import-file',
      helpId: 'map-import-file-help',
      errorId: 'map-import-file-error',
    });
  });

  test('sanitizes React useId tokens for CSS-safe prefixes', () => {
    expect(sanitizeFieldPrefix(':r1:')).toBe('r1');
    expect(sanitizeFieldPrefix(':r12:')).toBe('r12');
  });

  test('describedByFor includes help and error ids only when present', () => {
    const ids = fieldIds('inventory-add', 'qty');
    expect(describedByFor(ids, 'help text', null)).toBe(ids.helpId);
    expect(describedByFor(ids, null, 'bad qty')).toBe(ids.errorId);
    expect(describedByFor(ids, 'help text', 'bad qty', 'form-error')).toBe(
      `${ids.helpId} ${ids.errorId} form-error`,
    );
    expect(describedByFor(ids, undefined, null)).toBeUndefined();
  });

  test('encounter create name id stays aligned with issue #431 ENCOUNTER_NAME_ID', () => {
    expect(fieldIds(ENCOUNTER_CREATE_PREFIX, ENCOUNTER_FIELD.name).controlId).toBe(ENCOUNTER_NAME_ID);
    expect(ENCOUNTER_NAME_ID).toBe('encounter-name');
  });
});

test.describe('form field vocabulary (issue #886)', () => {
  test('character sheet edit exposes durable names, status help, and HP clamp help', () => {
    expect(CHARACTER_EDIT_PREFIX).toBe('character-edit');
    expect(CHARACTER_FIELD.name).toBe('name');
    expect(CHARACTER_NAME_LABEL).toBe('Name');
    expect(CHARACTER_AC_LABEL.toLowerCase()).toMatch(/armor/);
    expect(CHARACTER_STATUS_HELP.toLowerCase()).toMatch(/active|encounter/);
    expect(CHARACTER_HP_MAX_HELP.toLowerCase()).toMatch(/clamp/);
  });

  test('location DM secret help distinguishes secret-field privacy', () => {
    expect(LOCATION_EDIT_PREFIX).toBe('location-editor');
    expect(fieldIds(LOCATION_EDIT_PREFIX, LOCATION_FIELD.dmSecret).controlId).toBe(
      'location-editor-dmSecret',
    );
    expect(LOCATION_DM_SECRET_HELP.toLowerCase()).toMatch(/players never|stripped|non-dm/);
  });

  test('session zero charter + support fields keep one-per-line / optional help', () => {
    expect(SESSION_ZERO_PREFIX).toBe('session-zero');
    expect(SESSION_ZERO_FIELD.lines).toBe('lines');
    expect(SESSION_ZERO_LINES_HELP.toLowerCase()).toMatch(/one entry per line|per line/);
    expect(SESSION_ZERO_SUPPORT_LABEL.toLowerCase()).toMatch(/participate/);
  });

  test('inventory and map import name required file purpose/format help', () => {
    expect(INVENTORY_ADD_PREFIX).toBe('inventory-add');
    expect(INVENTORY_NAME_LABEL).toBe('Item name');
    expect(fieldIds(INVENTORY_ADD_PREFIX, INVENTORY_FIELD.qty).controlId).toBe('inventory-add-qty');
    expect(MAP_TITLE_LABEL).toBe('Map title');
    expect(MAP_FILE_LABEL.toLowerCase()).toMatch(/file|image/);
    expect(MAP_FILE_HELP.toLowerCase()).toMatch(/png|jpeg|webp/);
    expect(MAP_FILE_ACCEPT).toContain('image/png');
    expect(MAP_FILE_ACCEPT).toContain('image/webp');
  });

  test('notes/comments/AI table prefixes stay distinct for composers', () => {
    expect(NOTES_COMPOSE_PREFIX).not.toBe(COMMENTS_COMPOSE_PREFIX);
    expect(NOTES_FIELD.body).toBe('body');
    expect(NOTE_BODY_LABEL).toBe('Note body');
    expect(COMMENT_BODY_LABEL).toBe('Comment');
    expect(AI_TABLE_PREFIX).toBe('ai-table');
    expect(AI_TABLE_FIELD.action).toBe('action');
    expect(AI_TABLE_FIELD.scene).toBe('scene');
  });
});
