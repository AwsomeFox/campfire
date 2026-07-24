import { Dnd5eAdapter, normalizeStats } from '@campfire/schema';

export type SaveAbility = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

/**
 * #1040: pure 5e saving-throw math used by the `saving_throw` MCP tool.
 * Kept free of Nest/DB so unit tests exercise the same code path as production.
 */

/** 5e ability modifier from a 3–18 (or higher) score. */
export function abilityMod(score: number): number {
  return Dnd5eAdapter.abilityModifier(score);
}

/** 5e proficiency bonus by character level: +2 at 1–4, +3 at 5–8, … */
export function profBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/**
 * Resolve the d20 bonus for a save from stored character columns.
 * Stats keys are folded to uppercase (issue #48); save proficiency entries
 * are compared case-insensitively so mixed-case JSON cannot silently miss.
 */
export function resolveSavingThrow(input: {
  stats: Record<string, number> | null | undefined;
  saveProficiencies: string[] | null | undefined;
  ability: SaveAbility;
  level: number;
}): {
  score: number;
  abilityMod: number;
  proficient: boolean;
  profBonus: number;
  bonus: number;
} {
  const stats = normalizeStats(input.stats);
  const score = Number(stats[input.ability] ?? 10);
  const mod = abilityMod(score);
  const proficient = (input.saveProficiencies ?? []).some(
    (entry) => String(entry).trim().toUpperCase() === input.ability,
  );
  const proficiency = profBonus(input.level);
  return {
    score,
    abilityMod: mod,
    proficient,
    profBonus: proficiency,
    bonus: mod + (proficient ? proficiency : 0),
  };
}
