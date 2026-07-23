import { expect, test } from '@playwright/test';
import {
  FACTION_EDITOR_ID_PREFIX,
  FACTION_FIELD_NAMES,
  NPC_EDITOR_ID_PREFIX,
  NPC_FIELD_NAMES,
  PRIVACY_FIELD_NAMES,
  labeledFieldIds,
} from '../../src/components/LabeledField';

/**
 * Issue #777 — shared field primitive id/name contract.
 *
 * Pins the stable `${prefix}-${name}` shape used by NPC and Faction editors so
 * label association, proposal-mode name preservation, and e2e locators cannot
 * drift independently of the React wiring.
 */

test.describe('labeledFieldIds (issue #777)', () => {
  test('builds stable control/help/error ids from prefix + name', () => {
    expect(labeledFieldIds('npc-editor', 'name')).toEqual({
      controlId: 'npc-editor-name',
      helpId: 'npc-editor-name-help',
      errorId: 'npc-editor-name-error',
    });
    expect(labeledFieldIds(FACTION_EDITOR_ID_PREFIX, FACTION_FIELD_NAMES.reputation)).toEqual({
      controlId: 'faction-editor-reputation',
      helpId: 'faction-editor-reputation-help',
      errorId: 'faction-editor-reputation-error',
    });
  });

  test('NPC and Faction editor prefixes stay distinct and stable', () => {
    expect(NPC_EDITOR_ID_PREFIX).toBe('npc-editor');
    expect(FACTION_EDITOR_ID_PREFIX).toBe('faction-editor');
    expect(NPC_EDITOR_ID_PREFIX).not.toBe(FACTION_EDITOR_ID_PREFIX);
  });

  test('NPC field names cover text, select, textarea, and privacy controls', () => {
    expect(Object.values(NPC_FIELD_NAMES)).toEqual([
      'name',
      'role',
      'disposition',
      'locationId',
      'factionId',
      'body',
      'dmSecret',
      'hidden',
    ]);
  });

  test('Faction field names cover text, numeric, select, textarea, and privacy controls', () => {
    expect(Object.values(FACTION_FIELD_NAMES)).toEqual([
      'name',
      'kind',
      'standing',
      'reputation',
      'body',
      'goals',
      'dmSecret',
      'hidden',
    ]);
  });

  test('proposal-mode-visible NPC fields keep the same ids when DM-only keys are omitted', () => {
    const proposeVisible = ['name', 'role', 'disposition', 'locationId', 'factionId', 'body'] as const;
    const dmOnly = ['dmSecret', 'hidden'] as const;
    for (const name of proposeVisible) {
      expect(labeledFieldIds(NPC_EDITOR_ID_PREFIX, name).controlId).toBe(`${NPC_EDITOR_ID_PREFIX}-${name}`);
    }
    for (const name of dmOnly) {
      // DM-only ids remain reserved under the same prefix so they never collide
      // with propose-mode fields when the privacy group remounts.
      expect(labeledFieldIds(NPC_EDITOR_ID_PREFIX, name).controlId).toBe(`${NPC_EDITOR_ID_PREFIX}-${name}`);
      expect(proposeVisible).not.toContain(name);
    }
  });

  test('DM privacy hidden control id uses PRIVACY_FIELD_NAMES.hidden', () => {
    expect(labeledFieldIds(NPC_EDITOR_ID_PREFIX, PRIVACY_FIELD_NAMES.hidden)).toEqual({
      controlId: 'npc-editor-hidden',
      helpId: 'npc-editor-hidden-help',
      errorId: 'npc-editor-hidden-error',
    });
    expect(PRIVACY_FIELD_NAMES.hidden).toBe('hidden');
  });
});
