import type { Combatant, CombatantKind, DeathState, EncounterStatus, HpBand } from '@campfire/schema';

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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** The HP/death-save fields a combatant carries, and that an HP change recomputes. */
export interface CombatantHpState {
  kind: CombatantKind;
  hpCurrent: number;
  hpMax: number;
  hpTemp: number;
  deathState: DeathState;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
}

/** The HP-affecting slice of a CombatantUpdate patch. */
export interface CombatantHpPatch {
  hpDelta?: number;
  hpSet?: number;
  hpTemp?: number;
  deathSaveSuccesses?: number;
  deathSaveFailures?: number;
}

export type CombatantHpResult = Pick<
  CombatantHpState,
  'hpCurrent' | 'hpTemp' | 'deathState' | 'deathSaveSuccesses' | 'deathSaveFailures'
>;

/**
 * Pure 5e HP-application math (issue #57), extracted so it can be unit-tested and
 * run atomically inside the updateCombatant transaction. Applies, in order:
 *
 *  1. explicit `hpTemp` set (0 clears) and explicit death-save counter sets;
 *  2. the HP change — `hpSet` (absolute, clamped to [0, hpMax]) or `hpDelta`:
 *     - damage (delta < 0) is absorbed by temp HP FIRST, then hpCurrent, floored at 0;
 *     - a single hit whose overflow past 0 HP is >= hpMax kills a character outright
 *       (5e massive-damage instant death);
 *     - healing (delta > 0) is capped at hpMax and leaves temp HP untouched.
 *  3. death-state recompute (characters only — monsters go "down" at 0 with no saves):
 *     - hp > 0        -> `none`, counters reset to 0 (any healing revives + clears saves);
 *     - hp == 0       -> `dead` (instant death / 3 failures), `stable` (3 successes),
 *                        else `dying`. Damage taken while already at 0 is a death-save
 *                        failure (and un-stabilizes a `stable` creature).
 *
 * Returns only the mutated fields; hpMax/kind are inputs, not outputs.
 */
export function applyCombatantHp(state: CombatantHpState, patch: CombatantHpPatch): CombatantHpResult {
  const isCharacter = state.kind === 'character';
  let { hpCurrent, hpTemp, deathState, deathSaveSuccesses: succ, deathSaveFailures: fail } = state;
  const { hpMax } = state;

  // 1. explicit sets (DM overrides / recording a rolled death save).
  if (patch.hpTemp !== undefined) hpTemp = Math.max(0, patch.hpTemp);
  if (patch.deathSaveSuccesses !== undefined) succ = clamp(patch.deathSaveSuccesses, 0, 3);
  if (patch.deathSaveFailures !== undefined) fail = clamp(patch.deathSaveFailures, 0, 3);

  // 2. HP change.
  let instantDeath = false;
  let damagedWhileDown = false;
  if (patch.hpSet !== undefined) {
    hpCurrent = clamp(patch.hpSet, 0, hpMax);
  } else if (patch.hpDelta !== undefined && patch.hpDelta !== 0) {
    if (patch.hpDelta < 0) {
      let dmg = -patch.hpDelta;
      const absorbed = Math.min(hpTemp, dmg); // temp HP soaks damage first, doesn't cap at hpMax.
      hpTemp -= absorbed;
      dmg -= absorbed;
      if (dmg > 0) {
        damagedWhileDown = hpCurrent === 0;
        const overflow = dmg - hpCurrent; // damage remaining after dropping to 0.
        hpCurrent = Math.max(0, hpCurrent - dmg);
        if (isCharacter && hpCurrent === 0 && overflow >= hpMax) instantDeath = true;
      }
    } else {
      hpCurrent = Math.min(hpMax, hpCurrent + patch.hpDelta);
    }
  }
  // Re-clamp to [0, hpMax] so a lowered hpMax (a DM fixing a mistyped stat, issue
  // #114) pulls an over-max hpCurrent down with it.
  hpCurrent = clamp(hpCurrent, 0, hpMax);

  // 3. death-state recompute.
  if (!isCharacter) {
    // Monsters never track death saves — 0 HP is simply "down" (isDown / hpBand).
    return { hpCurrent, hpTemp, deathState: 'none', deathSaveSuccesses: 0, deathSaveFailures: 0 };
  }
  if (hpCurrent > 0) {
    // Regaining any HP revives a downed character and clears the death-save slate.
    deathState = 'none';
    succ = 0;
    fail = 0;
  } else if (instantDeath) {
    deathState = 'dead';
  } else {
    // At 0 HP. Taking damage while already down is an automatic death-save failure;
    // damage to a STABLE creature un-stabilizes it (its save slate resets first).
    if (damagedWhileDown && deathState !== 'dead') {
      if (deathState === 'stable') succ = 0;
      fail = Math.min(3, fail + 1);
    }
    if (fail >= 3 || deathState === 'dead') deathState = 'dead';
    else if (succ >= 3) deathState = 'stable';
    else deathState = 'dying';
  }
  return { hpCurrent, hpTemp, deathState, deathSaveSuccesses: succ, deathSaveFailures: fail };
}
