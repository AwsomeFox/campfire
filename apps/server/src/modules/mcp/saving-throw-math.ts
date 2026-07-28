import { Dnd5eAdapter, checkProficiencyBonusForAdapter, normalizeStats, type RuleSystemAdapter } from '@campfire/schema';

export type SaveAbility = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

/**
 * #1040: pure saving-throw math used by the `saving_throw` MCP tool.
 * Kept free of Nest/DB so unit tests exercise the same code path as production.
 *
 * #1599 — the ability modifier and proficiency bonus are now the CAMPAIGN'S adapter's own,
 * not a hardcoded 5e formula. `adapter` defaults to `Dnd5eAdapter` so every existing caller
 * (and every existing test in saving-throw-math.spec.ts, unmodified) gets byte-identical 5e
 * results — the tool's call site (mcp-tools.ts) resolves and passes the campaign's real
 * adapter explicitly.
 */

/** Ability modifier under `adapter` (defaults to 5e's `floor((score - 10) / 2)`). */
export function abilityMod(score: number, adapter: RuleSystemAdapter = Dnd5eAdapter): number {
  return adapter.abilityModifier(score);
}

/**
 * Proficiency bonus under `adapter` by character level (defaults to 5e's `+2 at 1–4, +3 at
 * 5–8, …`). Level is clamped to at least 1 BEFORE reaching the adapter — preserved exactly as
 * it was pre-#1599 (`profBonus(0) === profBonus(1)`), not delegated to the adapter's own
 * clamping (which differs — see `Pf2eAdapter.checkProficiencyBonus` — and exists for a
 * different caller, `ActionResolverService`, that has never clamped level at all).
 */
export function profBonus(level: number, adapter: RuleSystemAdapter = Dnd5eAdapter): number {
  return checkProficiencyBonusForAdapter(adapter, Math.max(1, level));
}

/**
 * Resolve the d20 bonus for a save from stored character columns, under `adapter` (defaults
 * to 5e). Stats keys are folded to uppercase (issue #48); save proficiency entries are
 * compared case-insensitively so mixed-case JSON cannot silently miss.
 */
export function resolveSavingThrow(input: {
  stats: Record<string, number> | null | undefined;
  saveProficiencies: string[] | null | undefined;
  ability: SaveAbility;
  level: number;
  adapter?: RuleSystemAdapter;
}): {
  score: number;
  abilityMod: number;
  proficient: boolean;
  profBonus: number;
  bonus: number;
} {
  const adapter = input.adapter ?? Dnd5eAdapter;
  const stats = normalizeStats(input.stats);
  const score = Number(stats[input.ability] ?? 10);
  const mod = abilityMod(score, adapter);
  const proficient = (input.saveProficiencies ?? []).some(
    (entry) => String(entry).trim().toUpperCase() === input.ability,
  );
  const proficiency = profBonus(input.level, adapter);
  return {
    score,
    abilityMod: mod,
    proficient,
    profBonus: proficiency,
    bonus: mod + (proficient ? proficiency : 0),
  };
}
