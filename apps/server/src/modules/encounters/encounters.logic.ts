import {
  Dnd5eAdapter,
  computeDnd5eEncounterDifficulty,
  crToXp,
  encounterMultiplier,
  parseCr,
  xpThresholdsForLevel,
} from '@campfire/schema';
import type {
  Combatant,
  CombatantKind,
  DeathState,
  DifficultyBand,
  EncounterDifficulty,
  EncounterEvent,
  EncounterShape,
  EncounterStatus,
  HpBand,
} from '@campfire/schema';

/** Re-export difficulty primitives so existing unit-test imports keep working. */
export { parseCr, crToXp, xpThresholdsForLevel, encounterMultiplier };

/** Display label for a combatant whose linked NPC is currently hidden from non-DMs (#374/#869). */
export const UNKNOWN_COMBATANT_LABEL = 'Unknown combatant';

/** Minimal combatant shape needed to project combat-log secrecy (issue #869). */
export type EncounterEventRedactionCombatant = {
  id: number;
  name: string;
  npcId: number | null;
};

/**
 * Role-aware combat-log projection (issue #869).
 *
 * Policy: historical events reveal names after the entity is revealed — redaction
 * uses the CURRENT hidden-NPC set, not the secrecy at write time. Stable
 * `actorId`/`targetId` drive the mask when present; denormalized actor/target
 * strings and any name-bearing `detail` prose are scrubbed as a backstop for
 * legacy rows (and for turn lines written before detail was name-free).
 *
 * Combatant ids themselves stay on the event so clients can correlate with the
 * initiative roster (which already shows the masked token under the same id).
 */
export function redactEncounterEventsForViewer(
  events: EncounterEvent[],
  combatants: EncounterEventRedactionCombatant[],
  hiddenNpcIds: ReadonlySet<number>,
): EncounterEvent[] {
  if (events.length === 0 || hiddenNpcIds.size === 0) return events;

  const hiddenCombatantIds = new Set<number>();
  const hiddenNames = new Set<string>();
  for (const c of combatants) {
    if (c.npcId !== null && hiddenNpcIds.has(c.npcId)) {
      hiddenCombatantIds.add(c.id);
      if (c.name) hiddenNames.add(c.name);
    }
  }
  if (hiddenCombatantIds.size === 0 && hiddenNames.size === 0) return events;

  return events.map((ev) => {
    const actorHidden =
      (ev.actorId != null && hiddenCombatantIds.has(ev.actorId)) ||
      (ev.actor != null && hiddenNames.has(ev.actor));
    const targetHidden =
      (ev.targetId != null && hiddenCombatantIds.has(ev.targetId)) ||
      (ev.target != null && hiddenNames.has(ev.target));

    let detail = ev.detail;
    if (hiddenNames.size > 0 && detail) {
      for (const name of hiddenNames) {
        if (name && detail.includes(name)) {
          detail = detail.split(name).join(UNKNOWN_COMBATANT_LABEL);
        }
      }
    }

    if (!actorHidden && !targetHidden && detail === ev.detail) return ev;
    return {
      ...ev,
      actor: actorHidden ? UNKNOWN_COMBATANT_LABEL : ev.actor,
      target: targetHidden ? UNKNOWN_COMBATANT_LABEL : ev.target,
      detail,
    };
  });
}

/**
 * Pure combat-order / HP-band math for encounters, extracted from
 * EncountersService so it can be unit-tested without a Nest/DB bootstrap
 * (issue #79). These functions take plain data in and return plain data out —
 * no `this`, no database, no side effects.
 */

/**
 * D&D 5e ability modifier: floor((score - 10) / 2). Delegates to the 5e RuleSystemAdapter
 * (issue #70) so there is a single implementation of the formula; kept here as a named
 * export for the pure difficulty/logic tests.
 */
export function abilityMod(score: number): number {
  return Dnd5eAdapter.abilityModifier(score);
}

// ---------------------------------------------------------------------------
// 5e encounter difficulty / XP-budget estimation (issues #58 + #429).
//
// Math, labels, assumptions, and support status live on the RuleSystemAdapter /
// @campfire/schema encounter-difficulty module. This thin wrapper keeps the
// generator + legacy unit-test call shape (`partyLevels, monsterCrs`).
// ---------------------------------------------------------------------------

/**
 * Compute an encounter's 5e difficulty band from the party's PC levels and the
 * combatant monsters' CRs. Delegates to the adapter-owned 5e estimator so
 * zero-data fights surface as `unknown` rather than a misleading Trivial band.
 */
export function computeEncounterDifficulty(partyLevels: number[], monsterCrs: (number | null)[]): EncounterDifficulty {
  return computeDnd5eEncounterDifficulty({
    partyLevels,
    monsterChallengeRatings: monsterCrs,
  });
}

// ---------------------------------------------------------------------------
// First-party encounter generator (issue #304).
//
// No open dataset of prebuilt encounters exists to import, but the two ingredients are
// already here — the monster compendium (rule_entries) and the 5e difficulty-band math
// above (#58). These pure functions assemble a themed monster group from a supplied
// candidate list to hit a target difficulty band for the party. Fully offline and
// deterministic: a `seed` reproduces the exact same group. No DB, no `this` — unit-tested
// in encounters-logic.spec.ts. The service layer supplies the candidates (queried from the
// compendium) and persists nothing here; committing is the normal create write path.
// ---------------------------------------------------------------------------

/** A compendium monster the generator may pick from (pre-scored by the service). */
export interface GeneratorCandidate {
  ruleEntryId: number;
  name: string;
  cr: number | null;
  xp: number;
  hpMax: number | null;
}

/** One selected monster line — a candidate plus the quantity to field. */
export interface GeneratorPick extends GeneratorCandidate {
  count: number;
}

export interface GenerateGroupOptions {
  partyLevels: number[];
  targetBand: DifficultyBand;
  candidates: GeneratorCandidate[];
  shape?: EncounterShape;
  maxCount: number;
  seed: number;
}

export interface GenerateGroupResult {
  picks: GeneratorPick[];
  difficulty: EncounterDifficulty;
  shape: EncounterShape;
  seed: number;
  matchedBand: boolean;
}

/**
 * mulberry32 — a tiny, fast, well-distributed seedable PRNG. Deterministic: the same
 * 32-bit seed always yields the same sequence, which is what makes generation
 * reproducible by `seed` (issue #304 acceptance criterion). Returns floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates shuffle driven by a seeded RNG (returns a new array). */
function seededShuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Inclusive [min, max] monster-count window for a requested shape, clamped to maxCount. */
function shapeCountRange(shape: EncounterShape | undefined, maxCount: number): [number, number] {
  const cap = Math.max(1, maxCount);
  switch (shape) {
    case 'solo':
      return [1, 1];
    case 'pair':
      return [Math.min(2, cap), Math.min(2, cap)];
    case 'group':
      return [Math.min(3, cap), Math.min(6, cap)];
    case 'horde':
      return [Math.min(7, cap), Math.min(12, cap)];
    default:
      return [1, cap];
  }
}

/** Classify a produced count into the shape bucket it best represents (for the result). */
function shapeForCount(count: number): EncounterShape {
  if (count <= 1) return 'solo';
  if (count === 2) return 'pair';
  if (count <= 6) return 'group';
  return 'horde';
}

const BAND_ORDER: DifficultyBand[] = ['trivial', 'easy', 'medium', 'hard', 'deadly'];

/** How many bands apart two difficulty bands are — the closeness score for best-effort fits. */
function bandDistance(a: DifficultyBand, b: DifficultyBand): number {
  return Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b));
}

/** Generator picks always produce a concrete band; treat a null band as maximally far. */
function bandDistanceOrMax(a: DifficultyBand | null, b: DifficultyBand): number {
  if (a === null) return BAND_ORDER.length;
  return bandDistance(a, b);
}

/**
 * Assemble a monster group hitting `targetBand` for `partyLevels` from `candidates`
 * (issue #304). Deterministic given `seed`.
 *
 * Strategy: seed-shuffle the usable candidates (xp > 0), then for each monster try every
 * count in the shape's window, classifying the resulting all-identical group via the SAME
 * #58 difficulty math (computeEncounterDifficulty) — so the group-size multiplier and CR→XP
 * table are reused, never re-derived. The first (in seeded order) group whose band equals
 * the target wins, giving reproducibility. If nothing lands exactly on the band (e.g. the
 * compendium can't field it for this party), the closest group by band distance — then by
 * how near its adjusted XP sits to the target threshold — is returned as best effort with
 * matchedBand:false. A homogeneous group ("Goblin ×4") is intentional for v1: it maps
 * cleanly onto add_combatant's `count`, reads as a themed encounter, and is easy to test.
 */
export function generateEncounterGroup(opts: GenerateGroupOptions): GenerateGroupResult {
  const { partyLevels, targetBand, candidates, shape, maxCount, seed } = opts;
  const rng = mulberry32(seed);
  const usable = candidates.filter((c) => c.xp > 0);
  const [countMin, countMax] = shapeCountRange(shape, maxCount);

  const empty = (): GenerateGroupResult => ({
    picks: [],
    difficulty: computeEncounterDifficulty(partyLevels, []),
    shape: shape ?? 'solo',
    seed,
    matchedBand: targetBand === 'trivial',
  });
  if (usable.length === 0) return empty();

  const shuffled = seededShuffle(usable, rng);
  // Target XP the band's threshold represents — used only to rank best-effort near-misses
  // toward the low edge of the band (a "medium" that just clears the medium threshold).
  const thresholds = computeEncounterDifficulty(partyLevels, []).thresholds;
  const targetXp =
    targetBand === 'trivial' ? Math.max(1, Math.floor(thresholds.easy / 2)) : thresholds[targetBand as 'easy' | 'medium' | 'hard' | 'deadly'];

  let best: { pick: GeneratorPick; difficulty: EncounterDifficulty; score: number; xpGap: number } | null = null;

  for (const m of shuffled) {
    for (let n = countMin; n <= countMax; n++) {
      const crs: (number | null)[] = Array.from({ length: n }, () => m.cr);
      const difficulty = computeEncounterDifficulty(partyLevels, crs);
      if (difficulty.band === targetBand) {
        return {
          picks: [{ ...m, count: n }],
          difficulty,
          shape: shape ?? shapeForCount(n),
          seed,
          matchedBand: true,
        };
      }
      const score = bandDistanceOrMax(difficulty.band, targetBand);
      const xpGap = Math.abs(difficulty.adjustedXp - targetXp);
      if (best === null || score < best.score || (score === best.score && xpGap < best.xpGap)) {
        best = { pick: { ...m, count: n }, difficulty, score, xpGap };
      }
    }
  }

  if (best === null) return empty();
  return {
    picks: [best.pick],
    difficulty: best.difficulty,
    shape: shape ?? shapeForCount(best.pick.count),
    seed,
    matchedBand: false,
  };
}

/**
 * Optional ruleset tiebreak for equal initiative totals (issue #611).
 * Adapters supply `RuleSystemAdapter.initiativeTiebreak`; when omitted, falls back to
 * `sortOrder` ascending (legacy insertion-order behavior).
 */
export type InitiativeTiebreak = (
  a: Pick<Combatant, 'initMod' | 'sortOrder' | 'id'>,
  b: Pick<Combatant, 'initMod' | 'sortOrder' | 'id'>,
) => number;

/**
 * Order combatants for display.
 * - `running`: initiative desc, nulls last (a just-added combatant with no
 *   initiative sinks to the bottom); equal totals use `tiebreak` when provided
 *   (per-adapter DEX-desc / preserved-roll-order — issue #611), else sortOrder asc.
 * - otherwise (preparing/ended): plain sortOrder asc.
 * Returns a new array; the input is never mutated.
 */
export function sortCombatants(
  rows: Combatant[],
  status: EncounterStatus,
  tiebreak?: InitiativeTiebreak,
): Combatant[] {
  if (status !== 'running') {
    return [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  const breakTie: InitiativeTiebreak = tiebreak ?? ((a, b) => a.sortOrder - b.sortOrder);
  return [...rows].sort((a, b) => {
    if (a.initiative === null && b.initiative === null) return breakTie(a, b);
    if (a.initiative === null) return 1;
    if (b.initiative === null) return -1;
    if (a.initiative !== b.initiative) return b.initiative - a.initiative;
    return breakTie(a, b);
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
  deathSaveRoll?: number;
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
 *     - a rolled death save (`deathSaveRoll`, issue #619) at 0 HP applies the 5e
 *                        crit/fumble rules: nat 1 = two failures; nat 20 = revive at 1 HP
 *                        (deathState none, saves cleared); 10–19 = one success; 2–9 = one
 *                        failure. The roll is applied to a dying/stable character only.
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
    // A rolled death save applies the 5e crit/fumble rules (issue #619) to a character
    // still at 0 HP (dying or stable). A nat 20 revives at 1 HP — set hpCurrent so the
    // final derivation treats it as "regained HP" (none + cleared saves). A nat 1 is two
    // failures; 2–9 a single failure; 10–19 a single success. The roll does NOT un-stabilize
    // a stable creature beyond its own outcome (the 5e rule), so we apply it regardless of
    // the prior stable/dying band — a success just adds to the slate, a failure adds a fail.
    if (patch.deathSaveRoll !== undefined && deathState !== 'dead') {
      const roll = patch.deathSaveRoll;
      if (roll === 20) {
        hpCurrent = Math.min(hpMax, 1); // revive at 1 HP (capped at max defensively)
        deathState = 'none';
        succ = 0;
        fail = 0;
      } else if (roll === 1) {
        fail = Math.min(3, fail + 2);
      } else if (roll >= 10) {
        succ = Math.min(3, succ + 1);
      } else {
        fail = Math.min(3, fail + 1);
      }
    }
    if (hpCurrent > 0) {
      // The nat-20 revival path set hpCurrent above; keep death-state already computed.
    } else if (fail >= 3 || deathState === 'dead') {
      deathState = 'dead';
    } else if (succ >= 3) {
      deathState = 'stable';
    } else {
      deathState = 'dying';
    }
  }
  return { hpCurrent, hpTemp, deathState, deathSaveSuccesses: succ, deathSaveFailures: fail };
}
