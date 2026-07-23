/**
 * Character sheet control accessible names (issue #448).
 *
 * Pure helpers so unit specs can pin vocabulary without mounting the page, and
 * so save/skill/XP/HP controls stay consistent if a future roll catalog (#415)
 * reuses the same labels.
 */

import type { SkillRank } from '@campfire/schema';
import type { Ability } from '../../lib/characterStats';

export type SkillProficiencyRank = SkillRank | 'none';

export function skillRankLabel(rank: SkillProficiencyRank): string {
  if (rank === 'expertise') return 'expertise';
  if (rank === 'proficient') return 'proficient';
  return 'not proficient';
}

/** Accessible name for a saving-throw proficiency toggle (pressed = proficient). */
export function saveProficiencyLabel(ability: Ability, proficient: boolean): string {
  return proficient
    ? `${ability} save proficiency, selected. Activate to remove`
    : `${ability} save proficiency, not selected. Activate to add`;
}

/** Accessible name for a skill proficiency cycle control (none → proficient → expertise). */
export function skillProficiencyLabel(skillName: string, rank: SkillProficiencyRank): string {
  return `${skillName} proficiency, ${skillRankLabel(rank)}. Activate to cycle`;
}

export const XP_AWARD_LABEL = 'XP award amount';

export const XP_AWARD_HELP =
  'Whole number of experience points to award (positive) or remove (negative).';

/** Contextual HP delta button name, matching Party QuickHp wording. */
export function hpDeltaLabel(
  characterName: string,
  step: number,
  hpCurrent: number,
  hpMax: number,
): string {
  const abs = Math.abs(step);
  const verb = step < 0 ? 'Reduce' : 'Increase';
  return `${verb} ${characterName}'s HP by ${abs} (hold Shift for ${abs * 5}; currently ${hpCurrent} of ${hpMax})`;
}

export function hpFullHealLabel(characterName: string, hpMax: number): string {
  return `Full heal ${characterName} to ${hpMax} HP`;
}
