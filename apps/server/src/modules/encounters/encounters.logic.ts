import type { Combatant, CombatantKind, DeathState, DifficultyBand, EncounterDifficulty, EncounterStatus, HpBand } from '@campfire/schema';

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

// ---------------------------------------------------------------------------
// 5e encounter difficulty / XP-budget estimation (issue #58).
//
// DMs used to build encounters blind — EncounterCreate was {name} only and the CR
// carried on compendium monsters (rule_entries.dataJson.challengeRating) plus the PC
// levels on character sheets were never combined. These pure functions do the standard
// 5e DMG math: monster CR -> XP, PC level -> XP thresholds, an encounter multiplier for
// the number of monsters, and a resulting Easy/Medium/Hard/Deadly band. No DB, no
// `this` — unit-testable in isolation (encounters-logic.spec.ts).
// ---------------------------------------------------------------------------

/** Standard 5e DMG XP-by-CR table. Keys are CR as a number (fractional CRs use 0.125/0.25/0.5). */
const XP_BY_CR: Record<string, number> = {
  '0': 10,
  '0.125': 25,
  '0.25': 50,
  '0.5': 100,
  '1': 200,
  '2': 450,
  '3': 700,
  '4': 1100,
  '5': 1800,
  '6': 2300,
  '7': 2900,
  '8': 3900,
  '9': 5000,
  '10': 5900,
  '11': 7200,
  '12': 8400,
  '13': 10000,
  '14': 11500,
  '15': 13000,
  '16': 15000,
  '17': 18000,
  '18': 20000,
  '19': 22000,
  '20': 25000,
  '21': 33000,
  '22': 41000,
  '23': 50000,
  '24': 62000,
  '25': 75000,
  '26': 90000,
  '27': 105000,
  '28': 120000,
  '29': 135000,
  '30': 155000,
};

/** Per-character-level XP thresholds (5e DMG "XP Thresholds by Character Level"). */
const XP_THRESHOLDS_BY_LEVEL: Record<number, { easy: number; medium: number; hard: number; deadly: number }> = {
  1: { easy: 25, medium: 50, hard: 75, deadly: 100 },
  2: { easy: 50, medium: 100, hard: 150, deadly: 200 },
  3: { easy: 75, medium: 150, hard: 225, deadly: 400 },
  4: { easy: 125, medium: 250, hard: 375, deadly: 500 },
  5: { easy: 250, medium: 500, hard: 750, deadly: 1100 },
  6: { easy: 300, medium: 600, hard: 900, deadly: 1400 },
  7: { easy: 350, medium: 750, hard: 1100, deadly: 1700 },
  8: { easy: 450, medium: 900, hard: 1300, deadly: 2100 },
  9: { easy: 550, medium: 1100, hard: 1600, deadly: 2400 },
  10: { easy: 600, medium: 1200, hard: 1900, deadly: 2800 },
  11: { easy: 800, medium: 1600, hard: 2400, deadly: 3600 },
  12: { easy: 1000, medium: 2000, hard: 3000, deadly: 4500 },
  13: { easy: 1100, medium: 2200, hard: 3400, deadly: 5100 },
  14: { easy: 1250, medium: 2500, hard: 3800, deadly: 5700 },
  15: { easy: 1400, medium: 2800, hard: 4300, deadly: 6400 },
  16: { easy: 1600, medium: 3200, hard: 4800, deadly: 7200 },
  17: { easy: 2000, medium: 3900, hard: 5900, deadly: 8800 },
  18: { easy: 2100, medium: 4200, hard: 6300, deadly: 9500 },
  19: { easy: 2400, medium: 4900, hard: 7300, deadly: 10900 },
  20: { easy: 2800, medium: 5700, hard: 8500, deadly: 12700 },
};

/**
 * Parse a monster's challenge rating into a numeric CR. Handles the number form the
 * open5e importer stores (e.g. 0.25, 5) and the string forms it can also carry
 * ("1/4", "1/8", "5"). Returns null for an unparseable / missing CR so the caller
 * can simply skip that monster rather than mis-score it.
 */
export function parseCr(cr: unknown): number | null {
  if (typeof cr === 'number' && Number.isFinite(cr)) return cr;
  if (typeof cr !== 'string') return null;
  const s = cr.trim();
  if (!s) return null;
  if (s.includes('/')) {
    const [num, den] = s.split('/');
    const n = Number(num);
    const d = Number(den);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n / d;
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Monster CR -> XP via the 5e table. Snaps fractional CRs to the nearest table key; null CR -> 0 XP. */
export function crToXp(cr: number | null): number {
  if (cr === null) return 0;
  // Exact table hit (covers 0, 0.125, 0.25, 0.5, and every integer 1..30).
  const direct = XP_BY_CR[String(cr)];
  if (direct !== undefined) return direct;
  // Fractional CR that isn't a table key: clamp into range, then round to the nearest
  // integer CR (fractional keys below 1 are handled by the direct hits above).
  const clamped = Math.max(0, Math.min(30, cr));
  const rounded = Math.round(clamped);
  return XP_BY_CR[String(rounded)] ?? 0;
}

/** XP thresholds for one PC level (clamped to the 1..20 table). */
export function xpThresholdsForLevel(level: number): { easy: number; medium: number; hard: number; deadly: number } {
  const clamped = Math.max(1, Math.min(20, Math.floor(level)));
  return XP_THRESHOLDS_BY_LEVEL[clamped];
}

/**
 * 5e "encounter multiplier" for the number of monsters — a larger group is more
 * dangerous than its raw XP sum (action economy). 1 -> ×1, 2 -> ×1.5, 3–6 -> ×2,
 * 7–10 -> ×2.5, 11–14 -> ×3, 15+ -> ×4.
 */
export function encounterMultiplier(monsterCount: number): number {
  if (monsterCount <= 0) return 0;
  if (monsterCount === 1) return 1;
  if (monsterCount === 2) return 1.5;
  if (monsterCount <= 6) return 2;
  if (monsterCount <= 10) return 2.5;
  if (monsterCount <= 14) return 3;
  return 4;
}

/**
 * Compute an encounter's 5e difficulty band from the party's PC levels and the
 * combatant monsters' CRs. Sums each PC's per-level XP thresholds into a party budget,
 * sums monster XP and applies the number-of-monsters multiplier, then buckets the
 * adjusted monster XP against the party thresholds. Below the Easy threshold is
 * `trivial`; an empty party (no PC levels) reports `trivial` with zeroed thresholds.
 */
export function computeEncounterDifficulty(partyLevels: number[], monsterCrs: (number | null)[]): EncounterDifficulty {
  const thresholds = { easy: 0, medium: 0, hard: 0, deadly: 0 };
  for (const level of partyLevels) {
    const t = xpThresholdsForLevel(level);
    thresholds.easy += t.easy;
    thresholds.medium += t.medium;
    thresholds.hard += t.hard;
    thresholds.deadly += t.deadly;
  }

  const totalMonsterXp = monsterCrs.reduce<number>((sum, cr) => sum + crToXp(cr), 0);
  const monsterCount = monsterCrs.length;
  const multiplier = encounterMultiplier(monsterCount);
  const adjustedXp = Math.round(totalMonsterXp * multiplier);

  let band: DifficultyBand = 'trivial';
  if (partyLevels.length > 0 && adjustedXp > 0) {
    if (adjustedXp >= thresholds.deadly) band = 'deadly';
    else if (adjustedXp >= thresholds.hard) band = 'hard';
    else if (adjustedXp >= thresholds.medium) band = 'medium';
    else if (adjustedXp >= thresholds.easy) band = 'easy';
    else band = 'trivial';
  }

  return {
    band,
    thresholds,
    partySize: partyLevels.length,
    partyLevels,
    monsterCount,
    totalMonsterXp,
    multiplier,
    adjustedXp,
  };
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
