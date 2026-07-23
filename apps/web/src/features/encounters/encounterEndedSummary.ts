/**
 * End-of-combat summary tallies (issue #492).
 *
 * "Fallen" previously used `isDown` (hpCurrent <= 0 / hpBand === 'down'), which
 * conflated genuinely dead/defeated creatures with stabilizable dying/stable PCs.
 * Split into Dead (defeated) vs Downed (still recoverable characters).
 */

export type SummaryCombatant = {
  name: string;
  kind: 'character' | 'monster' | 'npc';
  hpCurrent?: number | null;
  hpBand?: string | null;
  deathState?: 'none' | 'dying' | 'stable' | 'dead' | string | null;
};

/** At 0 HP, or (for a redacted monster) banded 'down'. */
export function isDown(c: SummaryCombatant): boolean {
  return c.hpCurrent != null ? c.hpCurrent <= 0 : c.hpBand === 'down';
}

/**
 * Dead / defeated for the summary tally:
 * - characters with `deathState === 'dead'`
 * - monsters/NPCs that are down (they don't roll death saves)
 */
export function isDead(c: SummaryCombatant): boolean {
  if (c.deathState === 'dead') return true;
  if (c.kind !== 'character' && isDown(c)) return true;
  return false;
}

/**
 * A character who is down but not dead (dying, stable, or 0 HP without a dead flag).
 * Monsters/NPCs are never "downed" in this sense — they count as dead when down.
 */
export function isDowned(c: SummaryCombatant): boolean {
  return c.kind === 'character' && isDown(c) && c.deathState !== 'dead';
}

export function endedSummaryTallies<T extends SummaryCombatant>(combatants: T[]): {
  dead: T[];
  downed: T[];
  survivors: T[];
} {
  const dead = combatants.filter(isDead);
  const downed = combatants.filter(isDowned);
  const survivors = combatants.filter((c) => !isDead(c) && !isDowned(c));
  return { dead, downed, survivors };
}
