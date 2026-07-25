import { expect, test } from '@playwright/test';
import {
  CHARACTER_SHEET_BUILD_SECTIONS,
  CHARACTER_SHEET_PLAY_SECTIONS,
  CHARACTER_SHEET_TAB_LABEL,
  characterSheetSectionId,
  characterSheetTabStorageKey,
  parseCharacterSheetFocusParam,
  parseCharacterSheetTabParam,
  resolveCharacterSheetTab,
  tabForFocus,
} from '../../src/features/characters/characterSheetTabs';

/**
 * Issue #646 — Character sheet Play vs Build/Profile IA.
 *
 * Pins tab resolution, deep-link focus aliases, section ordering (mobile scroll
 * reduction), and encounter-aware defaults without a browser.
 */

test.describe('character sheet tabs (issue #646)', () => {
  test('parses tab and focus query params with aliases', () => {
    expect(parseCharacterSheetTabParam('play')).toBe('play');
    expect(parseCharacterSheetTabParam('build')).toBe('build');
    expect(parseCharacterSheetTabParam('profile')).toBeNull();

    expect(parseCharacterSheetFocusParam('hp')).toBe('hp');
    expect(parseCharacterSheetFocusParam('saving-throws')).toBe('saves');
    expect(parseCharacterSheetFocusParam('spell-slots')).toBe('slots');
    expect(parseCharacterSheetFocusParam('story')).toBe('background');
    expect(parseCharacterSheetFocusParam('profile')).toBe('player');
    expect(parseCharacterSheetFocusParam('nope')).toBeNull();
  });

  test('maps focus targets to tabs and stable section ids', () => {
    expect(tabForFocus('hp')).toBe('play');
    expect(tabForFocus('xp')).toBe('build');
    expect(characterSheetSectionId('actions')).toBe('character-section-actions');
  });

  test('resolves tab precedence: url tab, focus, persisted, encounter default', () => {
    expect(
      resolveCharacterSheetTab({
        urlTab: 'build',
        urlFocus: 'hp',
        persistedTab: 'play',
        liveEncounter: true,
      }),
    ).toBe('build');

    expect(
      resolveCharacterSheetTab({
        urlTab: null,
        urlFocus: 'xp',
        persistedTab: 'play',
        liveEncounter: false,
      }),
    ).toBe('build');

    expect(
      resolveCharacterSheetTab({
        urlTab: null,
        urlFocus: null,
        persistedTab: 'build',
        liveEncounter: false,
      }),
    ).toBe('build');

    expect(
      resolveCharacterSheetTab({
        urlTab: null,
        urlFocus: null,
        persistedTab: null,
        liveEncounter: true,
      }),
    ).toBe('play');
  });

  test('play panel lists at-table sections before build-only content', () => {
    expect(CHARACTER_SHEET_PLAY_SECTIONS[0]).toBe('abilities');
    expect(CHARACTER_SHEET_PLAY_SECTIONS).toContain('hp');
    expect(CHARACTER_SHEET_PLAY_SECTIONS).toContain('actions');
    expect(CHARACTER_SHEET_PLAY_SECTIONS).not.toContain('xp');

    expect(CHARACTER_SHEET_BUILD_SECTIONS[0]).toBe('xp');
    expect(CHARACTER_SHEET_BUILD_SECTIONS).toContain('background');
    expect(CHARACTER_SHEET_BUILD_SECTIONS).not.toContain('hp');
  });

  test('storage keys are scoped per campaign and character', () => {
    expect(characterSheetTabStorageKey(1, 9)).toBe('cf.characterSheetTab.1.9');
    expect(characterSheetTabStorageKey(2, 9)).not.toBe(characterSheetTabStorageKey(1, 9));
  });

  test('tab labels are human-readable for the compact nav', () => {
    expect(CHARACTER_SHEET_TAB_LABEL.play).toMatch(/play/i);
    expect(CHARACTER_SHEET_TAB_LABEL.build).toMatch(/build/i);
    expect(CHARACTER_SHEET_TAB_LABEL.build).toMatch(/profile/i);
  });
});
