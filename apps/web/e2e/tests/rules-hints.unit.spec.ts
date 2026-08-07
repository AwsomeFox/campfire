import { expect, test } from '@playwright/test';
import { CONDITIONS, DND5E_ADAPTER_ID, STARFORGED_ADAPTER_ID } from '@campfire/schema';
import {
  conditionHintKey,
  rulesHintCompendiumHref,
  standardActionHintKey,
} from '../../src/lib/rulesHints';

// Mirrors STANDARD_ACTIONS' ids in TurnWorkspace.tsx — kept as a plain literal here (not an
// import) so this test independently exercises the same 9 ids the issue's acceptance
// criteria names, rather than trivially re-deriving them from the production array.
const STANDARD_ACTION_IDS = ['attack', 'dash', 'dodge', 'disengage', 'help', 'hide', 'ready', 'search', 'use'];

test.describe('rulesHints (issue #1939)', () => {
  test('5e returns a hint key for all 9 standard actions', () => {
    for (const actionId of STANDARD_ACTION_IDS) {
      expect(standardActionHintKey(DND5E_ADAPTER_ID, actionId), actionId).toBeTruthy();
    }
  });

  test('5e returns a hint key for all 15 CONDITIONS', () => {
    expect(CONDITIONS.length).toBe(15);
    for (const condition of CONDITIONS) {
      expect(conditionHintKey(DND5E_ADAPTER_ID, condition), condition).toBeTruthy();
    }
  });

  test('an unknown action id on 5e returns undefined', () => {
    expect(standardActionHintKey(DND5E_ADAPTER_ID, 'not-a-real-action')).toBeUndefined();
  });

  test('an unknown condition name on 5e returns undefined (custom/homebrew condition)', () => {
    expect(conditionHintKey(DND5E_ADAPTER_ID, 'Homebrew Curse')).toBeUndefined();
  });

  test('an adapter with no authored hints (Starforged) returns undefined for every standard action and condition — never falls back to 5e text', () => {
    for (const actionId of STANDARD_ACTION_IDS) {
      expect(standardActionHintKey(STARFORGED_ADAPTER_ID, actionId), actionId).toBeUndefined();
    }
    for (const condition of CONDITIONS) {
      expect(conditionHintKey(STARFORGED_ADAPTER_ID, condition), condition).toBeUndefined();
    }
  });

  test('a null/undefined/empty adapter id returns undefined rather than throwing', () => {
    expect(standardActionHintKey(null, 'dodge')).toBeUndefined();
    expect(standardActionHintKey(undefined, 'dodge')).toBeUndefined();
    expect(standardActionHintKey('', 'dodge')).toBeUndefined();
    expect(conditionHintKey(null, 'Restrained')).toBeUndefined();
    expect(conditionHintKey(undefined, 'Restrained')).toBeUndefined();
    expect(conditionHintKey('', 'Restrained')).toBeUndefined();
  });

  test('a leveled condition instance ("Frightened 2") resolves against its base-name hint', () => {
    const base = conditionHintKey(DND5E_ADAPTER_ID, 'Frightened');
    const leveled = conditionHintKey(DND5E_ADAPTER_ID, 'Frightened 2');
    expect(leveled).toBeTruthy();
    expect(leveled).toBe(base);
  });

  test('leveled normalization strips exactly one trailing " <integer>" and tolerates surrounding whitespace', () => {
    expect(conditionHintKey(DND5E_ADAPTER_ID, 'Exhaustion 6')).toBe(conditionHintKey(DND5E_ADAPTER_ID, 'Exhaustion'));
    expect(conditionHintKey(DND5E_ADAPTER_ID, '  Restrained  ')).toBe(conditionHintKey(DND5E_ADAPTER_ID, 'Restrained'));
    // A condition name that legitimately ends in digits with no space before them is NOT a
    // leveled instance of a DIFFERENT base name — it just fails to match anything (there is
    // no "Level5" condition), rather than being mangled into some other lookup.
    expect(conditionHintKey(DND5E_ADAPTER_ID, 'Level5')).toBeUndefined();
  });

  test('rulesHintCompendiumHref prefills the compendium search q param for the given campaign', () => {
    expect(rulesHintCompendiumHref(42, 'Dodge')).toBe('/c/42/compendium?q=Dodge');
    expect(rulesHintCompendiumHref(7, 'Frightened 2')).toBe('/c/7/compendium?q=Frightened%202');
  });
});
