import type { Combatant, EncounterStatus, HpBand } from '@campfire/schema';

/**
 * Pure combat-order / HP-band math for encounters, extracted from
 * EncountersService so it can be unit-tested without a Nest/DB bootstrap
 * (issue #79). These functions take plain data in and return plain data out —
 * no `this`, no database, no side effects.
 */

/** D&D 5e ability modifier: floor((score - 10) / 2). */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Order combatants for display.
 * - `running`: initiative desc, nulls last (a just-added combatant with no
 *   initiative sinks to the bottom), tie-broken by sortOrder asc.
 * - otherwise (preparing/ended): plain sortOrder asc.
 * Returns a new array; the input is never mutated.
 */
export function sortCombatants(rows: Combatant[], status: EncounterStatus): Combatant[] {
  if (status !== 'running') {
    return [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return [...rows].sort((a, b) => {
    if (a.initiative === null && b.initiative === null) return a.sortOrder - b.sortOrder;
    if (a.initiative === null) return 1;
    if (b.initiative === null) return -1;
    if (a.initiative !== b.initiative) return b.initiative - a.initiative;
    return a.sortOrder - b.sortOrder;
  });
}

/**
 * Position of `currentCombatantId` in the server-sorted running order — the
 * positional `turnIndex` kept in lockstep with the identity pointer (issue
 * #49). 0 when there's no current combatant or it's no longer present.
 */
export function turnIndexFor(sorted: Combatant[], currentCombatantId: number | null): number {
  if (currentCombatantId === null) return 0;
  const i = sorted.findIndex((c) => c.id === currentCombatantId);
  return i < 0 ? 0 : i;
}

/** Result of advancing the turn pointer over a sorted running order. */
export interface NextTurnState {
  turnIndex: number;
  round: number;
  currentCombatantId: number | null;
}

/**
 * Advance the turn pointer by identity, not raw position (issue #49). Steps
 * from wherever `currentCombatantId` sits in `sorted` to the next combatant,
 * wrapping to the top and incrementing `round` past the end. A missing/unset
 * pointer (legacy row, or the current actor was just removed) restarts at the
 * top of the current round. An empty encounter clears the pointer.
 */
export function advanceTurn(
  sorted: Combatant[],
  currentCombatantId: number | null,
  round: number,
): NextTurnState {
  const count = sorted.length;
  if (count === 0) {
    return { turnIndex: 0, round, currentCombatantId: null };
  }
  const currentIdx = currentCombatantId === null ? -1 : sorted.findIndex((c) => c.id === currentCombatantId);
  let nextIdx = currentIdx + 1;
  let nextRound = round;
  if (nextIdx >= count) {
    nextIdx = 0;
    nextRound += 1;
  }
  return { turnIndex: nextIdx, round: nextRound, currentCombatantId: sorted[nextIdx].id };
}

/**
 * Coarse HP status band shown to non-DM viewers in place of a monster's exact
 * HP (issue #43). `down` at 0 or below; then bucketed by fraction of max.
 */
export function hpBandFor(hpCurrent: number, hpMax: number): HpBand {
  if (hpCurrent <= 0) return 'down';
  const pct = hpMax > 0 ? hpCurrent / hpMax : 0;
  if (pct <= 0.25) return 'critical';
  if (pct <= 0.5) return 'bloodied';
  return 'healthy';
}
