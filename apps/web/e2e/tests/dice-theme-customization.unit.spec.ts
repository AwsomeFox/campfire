import { test, expect } from '@playwright/test';
import { DICE_THEMES, getDiceThemeSpec } from '../../src/features/dice/diceThemes';
import { DiceTheme } from '@campfire/schema';

test.describe('Per-player dice theme customization', () => {
  test('DICE_THEMES registry contains 8 distinct themes with valid spec properties', () => {
    expect(DICE_THEMES.length).toBe(8);
    const ids = DICE_THEMES.map((t) => t.id);
    expect(ids).toEqual([
      'nocturne',
      'obsidian_gold',
      'arcane_amethyst',
      'dragon_ruby',
      'celestial_pearl',
      'cyberpunk_neon',
      'eldritch_void',
      'mahogany_wood',
    ]);

    for (const theme of DICE_THEMES) {
      expect(theme.nameKey).toBeTruthy();
      expect(theme.descKey).toBeTruthy();
      expect(theme.previewBg).toBeTruthy();
      expect(theme.previewBorder).toBeTruthy();
      expect(theme.previewText).toBeTruthy();
    }
  });

  test('getDiceThemeSpec handles known and fallback themes', () => {
    expect(getDiceThemeSpec('obsidian_gold').id).toBe('obsidian_gold');
    expect(getDiceThemeSpec('dragon_ruby').id).toBe('dragon_ruby');
    expect(getDiceThemeSpec(null).id).toBe('nocturne');
    expect(getDiceThemeSpec(undefined).id).toBe('nocturne');
    expect(getDiceThemeSpec('invalid' as DiceTheme).id).toBe('nocturne');
  });
});
