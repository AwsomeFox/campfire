/**
 * Initiative tiebreak helpers (issue #611).
 *
 * When two combatants share the same initiative total, each RuleSystemAdapter decides
 * who goes first via `initiativeTiebreak`. These pure comparators are the shared building
 * blocks so every adapter (including ones in sibling files that cannot runtime-import
 * from `./index`) stays consistent without duplicating the comparison.
 */

/** Combatant fields consulted when breaking equal initiative totals. */
export interface InitiativeTiebreakCombatant {
  initMod: number;
  sortOrder: number;
  /** Optional stable identity; not used by the built-in comparators today. */
  id?: number;
}

/**
 * 5e-style / DEX-desc default: higher `initMod` (DEX mod for 5e) goes first; equal mods
 * fall back to earlier `sortOrder` (insertion / add order) as a deterministic stable
 * secondary. A full DM roll-off UI is out of scope — after DEX, the DM can manually
 * reorder or set initiative if they want a different outcome.
 */
export function initModDescThenSortOrderAsc(
  a: InitiativeTiebreakCombatant,
  b: InitiativeTiebreakCombatant,
): number {
  if (a.initMod !== b.initMod) return b.initMod - a.initMod;
  return a.sortOrder - b.sortOrder;
}

/**
 * PF2e-style preserved roll/add order: after equal initiative totals, keep `sortOrder`
 * ascending. Do NOT re-sort by DEX/`initMod` — PF2e ties stay in the order combatants
 * were rolled or added.
 */
export function sortOrderAscTiebreak(
  a: InitiativeTiebreakCombatant,
  b: InitiativeTiebreakCombatant,
): number {
  return a.sortOrder - b.sortOrder;
}
