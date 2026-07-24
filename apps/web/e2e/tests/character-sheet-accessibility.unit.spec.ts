import { expect, test } from '@playwright/test';
import {
  XP_AWARD_HELP,
  XP_AWARD_LABEL,
  hpDeltaLabel,
  hpFullHealLabel,
  saveProficiencyLabel,
  skillProficiencyLabel,
  skillRankLabel,
} from '../../src/features/characters/characterSheetA11y';

/**
 * Issue #448 — character sheet accessible-name vocabulary.
 *
 * Pins unique skill/save/XP/HP names so proficiency toggles never collapse to
 * “○” and HP deltas always include character context.
 */

test.describe('character sheet a11y vocabulary (issue #448)', () => {
  test('save proficiency labels are unique per ability and expose selected state', () => {
    expect(saveProficiencyLabel('STR', false)).toMatch(/STR save proficiency/i);
    expect(saveProficiencyLabel('STR', true)).toMatch(/selected/i);
    expect(saveProficiencyLabel('DEX', false)).not.toBe(saveProficiencyLabel('STR', false));
    expect(saveProficiencyLabel('WIS', true)).not.toBe(saveProficiencyLabel('WIS', false));
  });

  test('skill proficiency labels include the skill name and current rank', () => {
    expect(skillRankLabel('none')).toBe('not proficient');
    expect(skillRankLabel('proficient')).toBe('proficient');
    expect(skillRankLabel('expertise')).toBe('expertise');
    expect(skillProficiencyLabel('Athletics', 'none')).toMatch(/Athletics proficiency, not proficient/i);
    expect(skillProficiencyLabel('Stealth', 'expertise')).toMatch(/Stealth proficiency, expertise/i);
    expect(skillProficiencyLabel('Athletics', 'none')).not.toBe(skillProficiencyLabel('Acrobatics', 'none'));
  });

  test('XP award exposes a persistent label and help (not placeholder-only)', () => {
    expect(XP_AWARD_LABEL).toMatch(/XP/i);
    expect(XP_AWARD_HELP.length).toBeGreaterThan(XP_AWARD_LABEL.length);
    expect(XP_AWARD_HELP).toMatch(/experience|award|remove/i);
  });

  test('HP delta and full-heal labels include character name and current/max', () => {
    const delta = hpDeltaLabel('Aria', -1, 12, 30);
    expect(delta).toMatch(/Aria/);
    expect(delta).toMatch(/HP by 1/);
    expect(delta).toMatch(/12 of 30/);
    expect(hpDeltaLabel('Aria', 5, 12, 30)).not.toBe(hpDeltaLabel('Borin', 5, 12, 30));
    expect(hpFullHealLabel('Aria', 30)).toMatch(/Full heal Aria to 30 HP/);
  });
});
