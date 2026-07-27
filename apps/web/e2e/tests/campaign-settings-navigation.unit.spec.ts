import { expect, test } from '@playwright/test';
import settingsCatalog from '../../src/i18n/locales/en/settings.json';
import {
  SETTINGS_SECTIONS,
  settingsHashTarget,
  settingsSectionForHash,
} from '../../src/features/settings/settingsNavigation';

test.describe('campaign settings navigation model', () => {
  test('keeps the five canonical categories stable, ordered, and translated', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      'campaign',
      'gameplay-rules',
      'ai',
      'data',
      'lifecycle',
    ]);
    expect(Object.values(settingsCatalog.settings.categories).map((category) => category.label)).toEqual([
      'Campaign',
      'Gameplay / Rules',
      'AI',
      'Data',
      'Lifecycle',
    ]);
    for (const category of Object.values(settingsCatalog.settings.categories)) {
      expect(category.description.length).toBeGreaterThan(0);
    }
  });

  test('maps canonical, card, and legacy AI deep links to selected categories', () => {
    expect(settingsSectionForHash('#campaign')).toBe('campaign');
    expect(settingsSectionForHash('#campaign-general')).toBe('campaign');
    expect(settingsSectionForHash('#rule-system')).toBe('gameplay-rules');
    expect(settingsSectionForHash('#ai-dm')).toBe('ai');
    expect(settingsSectionForHash('#ai-dm-mode')).toBe('ai');
    expect(settingsSectionForHash('#ai-dm-provider')).toBe('ai');
    expect(settingsSectionForHash('#ai-dm-budget')).toBe('ai');
    expect(settingsSectionForHash('#ai-dm-instructions')).toBe('ai');
    // #1049 structured table style shares the AI category, so its deep link selects it too.
    expect(settingsSectionForHash('#ai-dm-style')).toBe('ai');
    expect(settingsSectionForHash('#export')).toBe('data');
    expect(settingsSectionForHash('#duplicate')).toBe('data');
    expect(settingsSectionForHash('#status')).toBe('lifecycle');
    expect(settingsSectionForHash('#danger-zone')).toBe('lifecycle');
  });

  test('decodes safe targets and ignores unknown or malformed hashes', () => {
    expect(settingsHashTarget('#gameplay-rules')).toBe('gameplay-rules');
    expect(settingsHashTarget('#ai%2Ddm')).toBe('ai-dm');
    expect(settingsHashTarget('#%E0%A4%A')).toBeNull();
    expect(settingsSectionForHash('#not-a-settings-section')).toBeNull();
    expect(settingsSectionForHash('')).toBeNull();
  });
});
