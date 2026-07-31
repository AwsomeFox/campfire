import {
  Dnd5eAdapter,
  DND5E_HP_MODEL,
  LEGENDARY_ACTION_SLOT,
  LEGENDARY_ACTIONS_PER_ROUND,
  LAIR_INITIATIVE_COUNT,
  MAX_PENDING_CONCENTRATION_CHECKS,
  actionEconomyForAdapter,
  computeDnd5eEncounterDifficulty,
  crToXp,
  encounterMultiplier,
  parseCr,
  xpThresholdsForLevel,
} from '@campfire/schema';
import type {
  ActionEconomySlot,
  ActiveEffect,
  Combatant,
  CombatantKind,
  ConcentrationCheck,
  CombatantTurnState,
  ConditionInstance,
  DeathState,
  DifficultyBand,
  EncounterDifficulty,
  EncounterEvent,
  EncounterShape,
  EncounterStatus,
  EncounterTurnPhase,
  EncounterWarning,
  HpBand,
  HpModel,
  PendingConcentrationCheck,
  RuleSystemAdapter,
  TurnPrompt,
} from '@campfire/schema';

/** Re-export difficulty primitives so existing unit-test imports keep working. */
export { parseCr, crToXp, xpThresholdsForLevel, encounterMultiplier };

/**
 * The maximum uses of one action-economy slot a combatant has this turn, or `null` when this
 * is a `cost.slot` / turn-state key the adapter's own {@link actionEconomyForAdapter} model
 * doesn't declare and isn't the legendary-action slot either (issue #1674, mirroring #1637's
 * `actionEconomySlotMax` in `action-resolver.service.ts`).
 *
 * `null` is deliberately NOT "unbounded is fine" — callers that DO want to bound this slot must
 * still refuse to invent a cap for an unrecognised key, matching this resolver's "refuse rather
 * than guess" convention elsewhere (an unknown AC, an unknown hit-die size): a wrong invented
 * limit could reject a legitimate homebrew slot key that predates this check.
 *
 * The legendary-action slot is the one key every adapter's economy model deliberately omits —
 * it is a per-MONSTER capability (does THIS statblock have a Legendary Actions section?), not a
 * per-system one (#618) — so the caller passes in whether the combatant's mapped statblock has
 * one; this function does not do statblock lookups itself so it stays usable both inside and
 * outside a DB transaction (`encounters.service.ts` computes this outside the transaction,
 * `action-resolver.service.ts` inside it — different structural shape, same rule).
 *
 * This is the SINGLE shared rule for bounding any action-economy slot in the encounters module
 * — both `updateCombatantTurnState`'s direct-patch path and the action-resolver's `apply_action`
 * spend path consume it, so "how many actions/reactions/legendary actions does this combatant
 * have" cannot drift between the two entry points.
 */
export function actionEconomySlotMax(
  adapter: Pick<RuleSystemAdapter, 'actionEconomy'>,
  slot: string,
  hasLegendaryActions: boolean,
): number | null {
  if (slot === LEGENDARY_ACTION_SLOT) {
    return hasLegendaryActions ? LEGENDARY_ACTIONS_PER_ROUND : 0;
  }
  const declared = actionEconomyForAdapter(adapter).slots.find((s) => s.key === slot);
  return declared ? declared.max : null;
}

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

    let metadata = ev.metadata;
    if (metadata && (actorHidden || targetHidden)) {
      const next = { ...metadata };
      if (next.dmText) next.dmText = undefined;
      if (next.playerText && hiddenNames.size > 0) {
        for (const name of hiddenNames) {
          if (name && next.playerText.includes(name)) {
            next.playerText = next.playerText.split(name).join(UNKNOWN_COMBATANT_LABEL);
          }
        }
      }
      metadata = next;
    }

    if (!actorHidden && !targetHidden && detail === ev.detail && metadata === ev.metadata) return ev;
    return {
      ...ev,
      actor: actorHidden ? UNKNOWN_COMBATANT_LABEL : ev.actor,
      target: targetHidden ? UNKNOWN_COMBATANT_LABEL : ev.target,
      detail,
      metadata,
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
  entryType?: 'monster' | 'hazard';
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
 * Optional ruleset tiebreak for equal *non-null* initiative totals (issue #611).
 * Adapters supply `RuleSystemAdapter.initiativeTiebreak`; when omitted, falls back to
 * `sortOrder` ascending (legacy insertion-order behavior).
 *
 * Unrolled combatants (`initiative === null`) always keep `sortOrder` order — adapter
 * DEX tiebreak must not reshuffle combatants that have not rolled yet.
 */
export type InitiativeTiebreak = (
  a: Pick<Combatant, 'initMod' | 'sortOrder' | 'id'>,
  b: Pick<Combatant, 'initMod' | 'sortOrder' | 'id'>,
) => number;

/**
 * Order combatants for display.
 * - `running`: initiative desc, nulls last (a just-added combatant with no
 *   initiative sinks to the bottom); equal *non-null* totals use `tiebreak` when
 *   provided (per-adapter DEX-desc / preserved-roll-order — issue #611), else
 *   sortOrder asc. Null/null pairs always use sortOrder (never adapter DEX).
 * - otherwise (preparing/ended): plain sortOrder asc.
 * Returns a new array; the input is never mutated.
 */
/** Campaign encounter-list status grouping (issue #490): active fights surface first. */
const ENCOUNTER_LIST_STATUS_RANK: Record<EncounterStatus, number> = {
  running: 0,
  preparing: 1,
  ended: 2,
};

export type EncounterListSortRow = {
  id: number;
  status: EncounterStatus;
  updatedAt: string;
};

/**
 * Default encounter-list ordering (issue #490): `running → preparing → ended`, then
 * `updatedAt` desc within each group. Optionally pin the campaign's authoritative
 * running fight to the very top (issue #744 legacy drift).
 */
export function sortEncountersForList<T extends EncounterListSortRow>(
  rows: T[],
  opts?: { pinActiveId?: number | null },
): T[] {
  const pinId = opts?.pinActiveId ?? null;
  return [...rows].sort((a, b) => {
    if (pinId != null) {
      if (a.id === pinId && b.id !== pinId) return -1;
      if (b.id === pinId && a.id !== pinId) return 1;
    }
    const statusDiff = ENCOUNTER_LIST_STATUS_RANK[a.status] - ENCOUNTER_LIST_STATUS_RANK[b.status];
    if (statusDiff !== 0) return statusDiff;
    const atDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (atDiff !== 0) return atDiff;
    return b.id - a.id;
  });
}

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
    // Unrolled combatants: preserve insertion order even when an adapter tiebreak
    // is supplied (do not sort by initMod/DEX before initiative is rolled).
    if (a.initiative === null && b.initiative === null) return a.sortOrder - b.sortOrder;
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

/** A combatant whose turn was auto-skipped during {@link advanceTurn} (issue #610). */
export interface SkippedTurnCombatant {
  id: number;
  name: string;
  /** The round the skipped turn would have occurred in. */
  round: number;
}

/** Result of advancing the turn pointer over a sorted running order. */
export interface NextTurnState {
  turnIndex: number;
  round: number;
  currentCombatantId: number | null;
  /** Combatants passed over because they are dead/defeated (issue #610). */
  skipped: SkippedTurnCombatant[];
}

/**
 * Whether a combatant's turn should be auto-skipped when advancing (issue #610).
 *
 * 5e rules: dead creatures and defeated monsters/NPCs at 0 HP are skipped; stable
 * PCs (unconscious, no death saves) are skipped; dying PCs still receive a turn for
 * death saving throws.
 */
export function shouldSkipTurnOnAdvance(c: Combatant): boolean {
  if (c.deathState === 'dead' || c.deathState === 'stable') return true;
  if (c.kind !== 'character' && c.hpCurrent != null && c.hpCurrent <= 0) return true;
  return false;
}

/** Boss-fight turn advance including lair slot at initiative 20 (issue #618). */
export interface EncounterTurnAdvanceState extends NextTurnState {
  phase: EncounterTurnPhase;
  lairResumeCombatantId: number | null;
  roundWrapped: boolean;
}

function initiativeValue(init: number | null): number {
  return init ?? Number.NEGATIVE_INFINITY;
}

/** True when this combatant is the last with initiative >= 20 before lower initiatives. */
export function shouldEnterLairAfterCombatant(combatant: Combatant, sorted: Combatant[]): boolean {
  const init = combatant.initiative;
  if (init === null || init < LAIR_INITIATIVE_COUNT) return false;
  const idx = sorted.findIndex((c) => c.id === combatant.id);
  if (idx < 0) return false;
  const next = sorted[idx + 1];
  if (!next) return true;
  const nextInit = next.initiative;
  return nextInit === null || nextInit < LAIR_INITIATIVE_COUNT;
}

/** Lair fires before anyone when no combatant rolled initiative 20+. */
export function lairLeadsRound(sorted: Combatant[]): boolean {
  return !sorted.some((c) => !shouldSkipTurnOnAdvance(c) && c.initiative !== null && c.initiative >= LAIR_INITIATIVE_COUNT);
}

/**
 * Advance the encounter turn pointer, inserting a lair-action slot at initiative count 20
 * when `hasLairSlot` is true (issue #618). Legendary usage is tracked separately on each
 * combatant's turn state and resets on round wrap in the service layer.
 */
export function advanceEncounterTurn(
  sorted: Combatant[],
  currentCombatantId: number | null,
  round: number,
  phase: EncounterTurnPhase,
  hasLairSlot: boolean,
  lairResumeCombatantId: number | null,
): EncounterTurnAdvanceState {
  const count = sorted.length;
  if (count === 0) {
    return {
      turnIndex: 0,
      round,
      currentCombatantId: null,
      skipped: [],
      phase: 'combatant',
      lairResumeCombatantId: null,
      roundWrapped: false,
    };
  }

  if (phase === 'lair') {
    const resumeId = lairResumeCombatantId ?? sorted.find((c) => initiativeValue(c.initiative) < LAIR_INITIATIVE_COUNT)?.id ?? sorted[0]?.id ?? null;
    const resumeIdx = resumeId === null ? 0 : turnIndexFor(sorted, resumeId);
    return {
      turnIndex: resumeIdx,
      round,
      currentCombatantId: resumeId,
      skipped: [],
      phase: 'combatant',
      lairResumeCombatantId: null,
      roundWrapped: false,
    };
  }

  const basic = advanceTurn(sorted, currentCombatantId, round);
  const roundWrapped = basic.round > round;
  const ending =
    currentCombatantId === null ? undefined : sorted.find((c) => c.id === currentCombatantId);
  const starting =
    basic.currentCombatantId === null ? undefined : sorted.find((c) => c.id === basic.currentCombatantId);

  if (!hasLairSlot || !ending) {
    return {
      ...basic,
      phase: 'combatant',
      lairResumeCombatantId: null,
      roundWrapped,
    };
  }

  if (shouldEnterLairAfterCombatant(ending, sorted) && starting) {
    return {
      turnIndex: turnIndexFor(sorted, ending.id),
      round: basic.round,
      currentCombatantId: null,
      skipped: basic.skipped,
      phase: 'lair',
      lairResumeCombatantId: starting.id,
      roundWrapped: false,
    };
  }

  return {
    ...basic,
    phase: 'combatant',
    lairResumeCombatantId: null,
    roundWrapped,
  };
}

/** Initial turn state when combat starts — lair may lead the round (issue #618). */
export function initialEncounterTurnState(
  sorted: Combatant[],
  hasLairSlot: boolean,
): Pick<EncounterTurnAdvanceState, 'currentCombatantId' | 'turnIndex' | 'phase' | 'lairResumeCombatantId'> {
  if (sorted.length === 0) {
    return { turnIndex: 0, currentCombatantId: null, phase: 'combatant', lairResumeCombatantId: null };
  }
  
  let firstIdx = 0;
  while (firstIdx < sorted.length && shouldSkipTurnOnAdvance(sorted[firstIdx])) {
    firstIdx++;
  }
  
  if (firstIdx >= sorted.length) {
    // All combatants skip
    return { turnIndex: 0, currentCombatantId: null, phase: 'combatant', lairResumeCombatantId: null };
  }

  if (hasLairSlot && lairLeadsRound(sorted)) {
    const first = sorted[firstIdx];
    return {
      turnIndex: firstIdx,
      currentCombatantId: null,
      phase: 'lair',
      lairResumeCombatantId: first.id,
    };
  }
  return {
    turnIndex: firstIdx,
    currentCombatantId: sorted[firstIdx].id,
    phase: 'combatant',
    lairResumeCombatantId: null,
  };
}

/**
 * Reverse of {@link advanceEncounterTurn} for DM undo (issue #618). The caller restores timed
 * condition and effect ticks from the advance event's snapshot (issue #1445).
 */
export function retreatEncounterTurn(
  sorted: Combatant[],
  currentCombatantId: number | null,
  round: number,
  phase: EncounterTurnPhase,
  hasLairSlot: boolean,
  lairResumeCombatantId: number | null,
): EncounterTurnAdvanceState {
  if (sorted.length === 0) {
    return {
      turnIndex: 0,
      round: Math.max(1, round),
      currentCombatantId: null,
      skipped: [],
      phase: 'combatant',
      lairResumeCombatantId: null,
      roundWrapped: false,
    };
  }

  if (phase === 'lair') {
    const resumeId = lairResumeCombatantId ?? sorted[0]?.id ?? null;
    let prev: Combatant | undefined;
    let wrappedToPrevRound = false;
    if (resumeId !== null) {
      const resumeIdx = sorted.findIndex((c) => c.id === resumeId);
      if (resumeIdx > 0) prev = sorted[resumeIdx - 1];
      else {
        prev = sorted[sorted.length - 1];
        wrappedToPrevRound = true;
      }
    }
    const retreatRound = wrappedToPrevRound ? Math.max(1, round - 1) : round;

    if (prev && hasLairSlot && shouldEnterLairAfterCombatant(prev, sorted)) {
      return {
        turnIndex: turnIndexFor(sorted, prev.id),
        round: retreatRound,
        currentCombatantId: prev.id,
        skipped: [],
        phase: 'combatant',
        lairResumeCombatantId: null,
        roundWrapped: wrappedToPrevRound,
      };
    }
    return {
      turnIndex: prev ? turnIndexFor(sorted, prev.id) : 0,
      round: retreatRound,
      currentCombatantId: prev?.id ?? null,
      skipped: [],
      phase: 'combatant',
      lairResumeCombatantId: null,
      roundWrapped: wrappedToPrevRound,
    };
  }

  const basic = retreatTurn(sorted, currentCombatantId, round);
  const ending =
    currentCombatantId === null ? undefined : sorted.find((c) => c.id === currentCombatantId);
  const starting =
    basic.currentCombatantId === null ? undefined : sorted.find((c) => c.id === basic.currentCombatantId);

  if (hasLairSlot && starting && shouldEnterLairAfterCombatant(starting, sorted)) {
    return {
      turnIndex: turnIndexFor(sorted, starting.id),
      round: basic.round,
      currentCombatantId: null,
      skipped: [],
      phase: 'lair',
      lairResumeCombatantId: ending?.id ?? currentCombatantId,
      roundWrapped: false,
    };
  }

  return {
    ...basic,
    phase: 'combatant',
    lairResumeCombatantId: null,
    roundWrapped: basic.round < round,
  };
}

/** Clear legendary-action usage for a new round (issue #618). */
export function resetLegendaryUsage(turnState: CombatantTurnState): CombatantTurnState {
  if (turnState.used[LEGENDARY_ACTION_SLOT] === undefined) return turnState;
  const used = { ...turnState.used };
  delete used[LEGENDARY_ACTION_SLOT];
  return { ...turnState, used };
}

/**
 * Advance the turn pointer by identity, not raw position (issue #49). Steps
 * from wherever `currentCombatantId` sits in `sorted` to the next combatant,
 * wrapping to the top and incrementing `round` past the end. Auto-skips
 * dead/defeated combatants per {@link shouldSkipTurnOnAdvance} (issue #610). A
 * missing/unset pointer (legacy row, or the current actor was just removed)
 * restarts at the top of the current round. An empty encounter clears the
 * pointer.
 */
export function advanceTurn(
  sorted: Combatant[],
  currentCombatantId: number | null,
  round: number,
): NextTurnState {
  const count = sorted.length;
  if (count === 0) {
    return { turnIndex: 0, round, currentCombatantId: null, skipped: [] };
  }
  const currentIdx = currentCombatantId === null ? -1 : sorted.findIndex((c) => c.id === currentCombatantId);
  let nextIdx = currentIdx + 1;
  let nextRound = round;
  const skipped: SkippedTurnCombatant[] = [];

  const stepForward = () => {
    if (nextIdx >= count) {
      nextIdx = 0;
      nextRound += 1;
    }
  };

  stepForward();

  let steps = 0;
  while (steps < count && shouldSkipTurnOnAdvance(sorted[nextIdx])) {
    skipped.push({ id: sorted[nextIdx].id, name: sorted[nextIdx].name, round: nextRound });
    nextIdx += 1;
    stepForward();
    steps += 1;
  }

  if (steps >= count || shouldSkipTurnOnAdvance(sorted[nextIdx])) {
    // Every combatant is dead/defeated — no active turn. Cap round to at most one wrap.
    return { turnIndex: 0, round: Math.min(nextRound, round + 1), currentCombatantId: null, skipped };
  }

  return { turnIndex: nextIdx, round: nextRound, currentCombatantId: sorted[nextIdx].id, skipped };
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
  /** Whether this combatant is currently maintaining a concentration effect. */
  isConcentrating?: boolean;
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
> & { concentrationCheck: ConcentrationCheck | null };

/** Derive the 5e concentration save from authoritative post-mitigation damage. */
export function concentrationCheckForDamage(
  isConcentrating: boolean | undefined,
  damage: number,
): ConcentrationCheck | null {
  // 5e rounds fractions down (PHB), so half of odd damage uses Math.floor.
  return isConcentrating && damage > 0
    ? { damage, dc: Math.max(10, Math.floor(damage / 2)) }
    : null;
}

/** Append one durable check idempotently while bounding persisted turn-state growth. */
export function enqueueConcentrationCheck(
  turnState: CombatantTurnState,
  check: PendingConcentrationCheck,
): CombatantTurnState {
  const withoutDuplicate = turnState.pendingConcentrationChecks.filter((pending) => pending.id !== check.id);
  return {
    ...turnState,
    pendingConcentrationChecks: [...withoutDuplicate, check].slice(-MAX_PENDING_CONCENTRATION_CHECKS),
  };
}

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
 * The 5e-specific death rules (massive damage, the death-save tracker) apply ONLY when the
 * rule-system adapter's `hpModel` says the system has them (issue #1503): a character in a
 * system without 5e death saves (Starforged, Open Legend, OSR, PF2e, …) drops to 0 HP and is
 * simply "down" — `deathState` stays `none`, counters stay 0 — exactly the monster path, never
 * accumulating death-save state a system without them does not have. Callers pass the model via
 * {@link hpModelForAdapter}; the default ({@link DND5E_HP_MODEL}) preserves this function's
 * pre-#1503 behaviour byte-identically for existing callers and unit tests.
 *
 * Returns only the mutated fields; hpMax/kind are inputs, not outputs.
 */
export function applyCombatantHp(
  state: CombatantHpState,
  patch: CombatantHpPatch,
  hpModel: HpModel = DND5E_HP_MODEL,
): CombatantHpResult {
  const isCharacter = state.kind === 'character';
  let { hpCurrent, hpTemp, deathState, deathSaveSuccesses: succ, deathSaveFailures: fail } = state;
  const { hpMax } = state;

  // 1. explicit sets (DM overrides / recording a rolled death save). Death-save counter sets
  //    are a no-op for a system without 5e death saves, so a client/MCP patch can't write them.
  if (patch.hpTemp !== undefined) hpTemp = Math.max(0, patch.hpTemp);
  if (hpModel.deathSaves) {
    if (patch.deathSaveSuccesses !== undefined) succ = clamp(patch.deathSaveSuccesses, 0, 3);
    if (patch.deathSaveFailures !== undefined) fail = clamp(patch.deathSaveFailures, 0, 3);
  }

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
        // 5e massive-damage instant death (issue #1503): gated on the adapter's hpModel so a
        // system without it drops to 0 HP ("down") instead of dying on a single big hit.
        if (hpModel.massiveDamageInstantDeath && isCharacter && hpCurrent === 0 && overflow >= hpMax) instantDeath = true;
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
    const damage = patch.hpSet === undefined && patch.hpDelta !== undefined && patch.hpDelta < 0 ? -patch.hpDelta : 0;
    return {
      hpCurrent,
      hpTemp,
      deathState: 'none',
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
      concentrationCheck: concentrationCheckForDamage(state.isConcentrating, damage),
    };
  }
  if (!hpModel.deathSaves) {
    // A character in a system WITHOUT 5e death saves (issue #1503): the 5e death-save tracker
    // and massive-damage instant death do not apply, so this engine does NOT recompute
    // deathState — it preserves whatever the system or DM already set. A DM-flagged 'dead'
    // stays 'dead' (it must not be resurrected by an unrelated HP tweak — review of #1503); a
    // Starfinder combatant keeps the 'dying'/'dead' its own damage model computed; a combatant
    // simply reduced to 0 HP keeps the default 'none' and is "down" via hpBand. The death-save
    // counters cannot accumulate for a non-death-save system (their write paths are gated on
    // hpModel.deathSaves above), so they are passed through unchanged. Massive damage was
    // already gated off above, so instantDeath is false here regardless.
    const damage = patch.hpSet === undefined && patch.hpDelta !== undefined && patch.hpDelta < 0 ? -patch.hpDelta : 0;
    return {
      hpCurrent,
      hpTemp,
      deathState,
      deathSaveSuccesses: succ,
      deathSaveFailures: fail,
      concentrationCheck: concentrationCheckForDamage(state.isConcentrating, damage),
    };
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
  const damage = patch.hpSet === undefined && patch.hpDelta !== undefined && patch.hpDelta < 0 ? -patch.hpDelta : 0;
  return {
    hpCurrent,
    hpTemp,
    deathState,
    deathSaveSuccesses: succ,
    deathSaveFailures: fail,
    concentrationCheck: concentrationCheckForDamage(state.isConcentrating, damage),
  };
}

// ---------------------------------------------------------------------------
// Current-turn workspace pure logic (issue #413).
//
// These functions are the deterministic heart of the turn workspace: reversing the
// turn pointer for undo, resetting a combatant's per-turn action economy when its turn
// starts, ticking timed effects down when its turn ends, and deriving the start/end-of-turn
// prompts a player and DM should resolve. No `this`, no DB, no side effects — unit-tested in
// encounters-logic.spec.ts and reused inside the service's serialized advancement transaction.
// ---------------------------------------------------------------------------

/**
 * Reverse of {@link advanceTurn} (issue #413, undo advance). Steps the pointer BACKWARD over
 * `sorted` from `currentCombatantId` to the previous combatant, unwrapping to the last
 * combatant and decrementing `round` when stepping back past the top. `round` never drops
 * below 1 (a running encounter is always at least round 1), so undo at the very first turn is
 * a no-op on round. A missing/unset pointer restarts at the top of the current round.
 */
export function retreatTurn(
  sorted: Combatant[],
  currentCombatantId: number | null,
  round: number,
): NextTurnState {
  const count = sorted.length;
  if (count === 0) {
    return { turnIndex: 0, round: Math.max(1, round), currentCombatantId: null, skipped: [] };
  }
  const currentIdx = currentCombatantId === null ? -1 : sorted.findIndex((c) => c.id === currentCombatantId);
  // Unset/last-removed pointer: restart at the top of the current round (mirrors advanceTurn).
  if (currentIdx < 0) {
    return { turnIndex: 0, round: Math.max(1, round), currentCombatantId: sorted[0].id, skipped: [] };
  }

  let prevIdx = currentIdx;
  let prevRound = round;

  const stepBackward = () => {
    prevIdx -= 1;
    if (prevIdx < 0) {
      prevIdx = count - 1;
      prevRound = Math.max(1, prevRound - 1);
    }
  };

  stepBackward();

  let steps = 0;
  while (steps < count && shouldSkipTurnOnAdvance(sorted[prevIdx])) {
    stepBackward();
    steps += 1;
  }

  if (steps >= count || shouldSkipTurnOnAdvance(sorted[prevIdx])) {
    return { turnIndex: 0, round: Math.max(1, round), currentCombatantId: null, skipped: [] };
  }

  return { turnIndex: prevIdx, round: prevRound, currentCombatantId: sorted[prevIdx].id, skipped: [] };
}

/**
 * Reset a combatant's per-turn action economy at the START of its own turn (issue #413).
 * Slots that reset at 'turn' AND those that reset at 'round' both refresh here (a 5e reaction
 * resets "at the start of your turn"), so `used` is cleared for every slot and movement is
 * zeroed. Concentration and its pending saves PERSIST across turns (they resolve explicitly);
 * `delaying`/`readied` clear because the combatant is now taking its turn.
 * Returns a new turn-state; the input is not mutated.
 */
export function resetTurnStateForStart(turnState: CombatantTurnState): CombatantTurnState {
  const legendaryUsed = turnState.used[LEGENDARY_ACTION_SLOT];
  const used =
    legendaryUsed === undefined ? {} : ({ [LEGENDARY_ACTION_SLOT]: legendaryUsed } as Record<string, number>);
  return {
    used,
    movementUsedFt: 0,
    concentration: turnState.concentration,
    pendingConcentrationChecks: turnState.pendingConcentrationChecks,
    delaying: false,
    readied: null,
  };
}

/** One expired/ticked effect surfaced from {@link tickEffectsAtTurnEnd} for combat-log lines. */
export interface EffectTickResult {
  kept: ActiveEffect[];
  expired: ActiveEffect[];
}

/**
 * Tick a combatant's timed effects down at the END of its turn (issue #413). Effects with a
 * finite `roundsRemaining` decrement by one; those reaching 0 are moved to `expired` (dropped
 * from the roster) so the service can log an 'effect' expiry line. Indefinite effects
 * (roundsRemaining === null) are kept untouched. Returns new arrays; the input is not mutated.
 */
export function tickEffectsAtTurnEnd(effects: ActiveEffect[]): EffectTickResult {
  const kept: ActiveEffect[] = [];
  const expired: ActiveEffect[] = [];
  for (const e of effects) {
    if (e.roundsRemaining === null) {
      kept.push(e);
      continue;
    }
    const remaining = e.roundsRemaining - 1;
    if (remaining <= 0) {
      expired.push(e);
    } else {
      kept.push({ ...e, roundsRemaining: remaining });
    }
  }
  return { kept, expired };
}

export interface ConditionTickResult {
  kept: ConditionInstance[];
  expired: ConditionInstance[];
}

/**
 * Tick a combatant's condition instances at turn end (issue #423).
 */
export function tickConditionInstancesAtTurnEnd(instances: ConditionInstance[]): ConditionTickResult {
  const kept: ConditionInstance[] = [];
  const expired: ConditionInstance[] = [];
  for (const c of instances) {
    if (c.roundsRemaining === null || c.timing === 'start-of-turn') {
      kept.push(c);
      continue;
    }
    const remaining = c.roundsRemaining - 1;
    if (remaining <= 0) {
      expired.push(c);
    } else {
      kept.push({ ...c, roundsRemaining: remaining });
    }
  }
  return { kept, expired };
}

/**
 * Tick a combatant's condition instances at turn start (issue #423).
 */
export function tickConditionInstancesAtTurnStart(instances: ConditionInstance[]): ConditionTickResult {
  const kept: ConditionInstance[] = [];
  const expired: ConditionInstance[] = [];
  for (const c of instances) {
    if (c.roundsRemaining === null || c.timing !== 'start-of-turn') {
      kept.push(c);
      continue;
    }
    const remaining = c.roundsRemaining - 1;
    if (remaining <= 0) {
      expired.push(c);
    } else {
      kept.push({ ...c, roundsRemaining: remaining });
    }
  }
  return { kept, expired };
}

export interface ConcentrationCascadeResult {
  updatedCombatants: Map<number, ConditionInstance[]>;
  removed: { combatantId: number; condition: ConditionInstance }[];
}

/**
 * When a combatant loses concentration, remove all concentration-linked condition instances
 * (isConcentration === true && sourceCombatantId === casterCombatantId) across all combatants in the fight (issue #423).
 */
export function cascadeConcentrationLoss(
  combatants: Array<{ id: number; conditionInstances: ConditionInstance[] }>,
  casterCombatantId: number,
  effectName?: string | null,
): ConcentrationCascadeResult {
  const updatedCombatants = new Map<number, ConditionInstance[]>();
  const removed: { combatantId: number; condition: ConditionInstance }[] = [];

  for (const combatant of combatants) {
    const kept: ConditionInstance[] = [];
    let changed = false;
    for (const cond of combatant.conditionInstances ?? []) {
      if (
        cond.isConcentration &&
        cond.sourceCombatantId === casterCombatantId &&
        (effectName == null || cond.source === effectName || cond.source == null)
      ) {
        removed.push({ combatantId: combatant.id, condition: cond });
        changed = true;
      } else {
        kept.push(cond);
      }
    }
    if (changed) {
      updatedCombatants.set(combatant.id, kept);
    }
  }

  return { updatedCombatants, removed };
}

/** Minimal combatant slice the prompt derivation reads (avoids importing the full domain type). */
export interface TurnPromptCombatant {
  id: number;
  name: string;
  kind: CombatantKind;
  deathState: DeathState;
  activeEffects: ActiveEffect[];
  conditionInstances?: ConditionInstance[];
  turnState: CombatantTurnState;
}

/**
 * Derive the START-of-turn prompts for a combatant (issue #413, #423): a death save for a dying PC,
 * ongoing damage/regen, and start-of-turn repeat saves for active effects and condition instances.
 */
export function deriveStartTurnPrompts(c: TurnPromptCombatant): TurnPrompt[] {
  const prompts: TurnPrompt[] = [];
  if (c.kind === 'character' && (c.deathState === 'dying' || c.deathState === 'stable')) {
    prompts.push({
      id: `death-save:${c.id}`,
      kind: 'death-save',
      timing: 'start',
      combatantId: c.id,
      combatantName: c.name,
      message:
        c.deathState === 'stable'
          ? 'Stable at 0 HP — no death save needed unless it takes damage.'
          : 'Down at 0 HP — roll a death saving throw.',
      effectId: null,
    });
  }
  for (const e of c.activeEffects) {
    if (e.timing !== 'start-of-turn') continue;
    if (e.kind === 'ongoing-damage') {
      prompts.push({
        id: `ongoing:${c.id}:${e.id}`,
        kind: 'ongoing-damage',
        timing: 'start',
        combatantId: c.id,
        combatantName: c.name,
        message: e.amount != null ? `Take ${e.amount} ongoing damage from ${e.name}.` : `Resolve ongoing damage from ${e.name}.`,
        effectId: e.id,
      });
    } else if (e.kind === 'regeneration') {
      prompts.push({
        id: `regen:${c.id}:${e.id}`,
        kind: 'regeneration',
        timing: 'start',
        combatantId: c.id,
        combatantName: c.name,
        message: e.amount != null ? `Regain ${e.amount} HP from ${e.name}.` : `Resolve regeneration from ${e.name}.`,
        effectId: e.id,
      });
    }
    if (e.saveAbility) {
      prompts.push({
        id: `repeat-save:start:${c.id}:${e.id}`,
        kind: 'repeat-save',
        timing: 'start',
        combatantId: c.id,
        combatantName: c.name,
        message: `Repeat ${e.saveAbility}${e.saveDc != null ? ` DC ${e.saveDc}` : ''} save against ${e.name}.`,
        effectId: e.id,
      });
    }
  }
  if (c.conditionInstances) {
    for (const cond of c.conditionInstances) {
      if (cond.saveTiming === 'start-of-turn' && cond.saveAbility) {
        prompts.push({
          id: `repeat-save-cond:start:${c.id}:${cond.id}`,
          kind: 'repeat-save',
          timing: 'start',
          combatantId: c.id,
          combatantName: c.name,
          message: `Repeat ${cond.saveAbility}${cond.saveDc != null ? ` DC ${cond.saveDc}` : ''} save against ${cond.name}.`,
          effectId: cond.id,
        });
      }
    }
  }
  return prompts;
}

/**
 * Derive the END-of-turn prompts for a combatant (issue #413): effects that expire this turn,
 * end-of-turn repeat saves and HP ticks, and unresolved actions (an action-economy slot with
 * remaining uses). `slots` is the campaign adapter's action-economy model so "unresolved
 * action" reflects the real system (5e Action, PF2e's three actions, …), never a 5e constant.
 */
export function deriveEndTurnPrompts(c: TurnPromptCombatant, slots: readonly ActionEconomySlot[]): TurnPrompt[] {
  const prompts: TurnPrompt[] = [];
  for (const e of c.activeEffects) {
    if (e.roundsRemaining !== null && e.roundsRemaining <= 1) {
      prompts.push({
        id: `expiring:${c.id}:${e.id}`,
        kind: 'expiring-effect',
        timing: 'end',
        combatantId: c.id,
        combatantName: c.name,
        message: `${e.name} expires at the end of this turn.`,
        effectId: e.id,
      });
    }
    if (e.timing === 'end-of-turn') {
      if (e.kind === 'ongoing-damage') {
        prompts.push({
          id: `ongoing:end:${c.id}:${e.id}`,
          kind: 'ongoing-damage',
          timing: 'end',
          combatantId: c.id,
          combatantName: c.name,
          message: e.amount != null ? `Take ${e.amount} ongoing damage from ${e.name}.` : `Resolve ongoing damage from ${e.name}.`,
          effectId: e.id,
        });
      } else if (e.kind === 'regeneration') {
        prompts.push({
          id: `regen:end:${c.id}:${e.id}`,
          kind: 'regeneration',
          timing: 'end',
          combatantId: c.id,
          combatantName: c.name,
          message: e.amount != null ? `Regain ${e.amount} HP from ${e.name}.` : `Resolve regeneration from ${e.name}.`,
          effectId: e.id,
        });
      }
      if (e.saveAbility) {
        prompts.push({
          id: `repeat-save:end:${c.id}:${e.id}`,
          kind: 'repeat-save',
          timing: 'end',
          combatantId: c.id,
          combatantName: c.name,
          message: `Repeat ${e.saveAbility}${e.saveDc != null ? ` DC ${e.saveDc}` : ''} save against ${e.name} (save ends).`,
          effectId: e.id,
        });
      }
    }
  }
  if (c.conditionInstances) {
    for (const cond of c.conditionInstances) {
      if (cond.roundsRemaining !== null && cond.roundsRemaining <= 1 && cond.timing !== 'start-of-turn') {
        prompts.push({
          id: `expiring-cond:${c.id}:${cond.id}`,
          kind: 'expiring-effect',
          timing: 'end',
          combatantId: c.id,
          combatantName: c.name,
          message: `Condition ${cond.name}${cond.stacks > 1 ? ` (×${cond.stacks})` : ''} expires at the end of this turn.`,
          effectId: cond.id,
        });
      }
      if (cond.saveTiming === 'end-of-turn' && cond.saveAbility) {
        prompts.push({
          id: `repeat-save-cond:end:${c.id}:${cond.id}`,
          kind: 'repeat-save',
          timing: 'end',
          combatantId: c.id,
          combatantName: c.name,
          message: `Repeat ${cond.saveAbility}${cond.saveDc != null ? ` DC ${cond.saveDc}` : ''} save against ${cond.name} (save ends).`,
          effectId: cond.id,
        });
      }
    }
  }
  // Unresolved PRIMARY action: only the first action-kind slot (5e "Action", PF2e "Actions")
  // raises an end-of-turn prompt when it still has uses left. Leaving a bonus action or a
  // reaction unspent is normal play, so those never nag.
  const primaryAction = slots.find((s) => s.kind === 'action');
  if (primaryAction) {
    const used = c.turnState.used[primaryAction.key] ?? 0;
    if (used < primaryAction.max) {
      prompts.push({
        id: `unresolved:${c.id}:${primaryAction.key}`,
        kind: 'unresolved-action',
        timing: 'end',
        combatantId: c.id,
        combatantName: c.name,
        message: `${primaryAction.label} not yet used (${primaryAction.max - used} of ${primaryAction.max} remaining).`,
        effectId: null,
      });
    }
  }
  return prompts;
}

// ---------------------------------------------------------------------------
// Interactive multi-slot roster build + deterministic tune (issue #412).
//
// The #304 generator produces a single homogeneous line. The preview-and-tune wizard needs
// a multi-slot roster the DM can reroll/swap/pin one slot at a time, reproducibly. These pure
// functions generalize the generator: a "slot" is a stack of identical creatures, and each
// (re)generation fills ONE slot against the difficulty contributed by the OTHER slots — reusing
// the exact #58 math (computeEncounterDifficulty) over the whole roster so the number-of-monsters
// multiplier is always honoured. Deterministic given the slot seeds; no DB, no `this`.
// ---------------------------------------------------------------------------

/** One roster slot's persistent plan — the round-trippable state a tune operation mutates. */
export interface RosterSlotPlan {
  slotId: string;
  ruleEntryId: number;
  count: number;
  pinned: boolean;
  seed: number;
}

/** A deterministic tuning operation applied to a roster plan (issue #412). */
export type RosterTuneOp =
  | { op: 'reroll-all'; seed?: number }
  | { op: 'reroll-slot'; slotId: string; seed?: number }
  | { op: 'swap-slot'; slotId: string; ruleEntryId: number }
  | { op: 'adjust-count'; slotId: string; count: number }
  | { op: 'pin'; slotId: string; pinned: boolean }
  | { op: 'add-slot'; seed?: number }
  | { op: 'remove-slot'; slotId: string };

export interface BuildRosterOptions {
  partyLevels: number[];
  targetBand: DifficultyBand;
  candidates: GeneratorCandidate[];
  maxCount: number;
  shape?: EncounterShape;
  seed: number;
  /** Existing plan being tuned; omit for a fresh generation. */
  plan?: RosterSlotPlan[];
  tune?: RosterTuneOp;
}

export interface BuildRosterResult {
  plan: RosterSlotPlan[];
  picks: GeneratorPick[];
  difficulty: EncounterDifficulty;
  shape: EncounterShape;
  seed: number;
  matchedBand: boolean;
}

/** Deterministic next seed from a prior one (LCG step) — used when a reroll omits an explicit seed. */
function deriveSeed(prev: number, salt = 0): number {
  return (Math.imul(prev ^ salt, 1664525) + 1013904223) >>> 0;
}

/** Flatten a plan into the per-copy CR list the #58 math consumes (missing candidate -> null CR). */
function crsForPlan(plan: RosterSlotPlan[], byId: Map<number, GeneratorCandidate>): (number | null)[] {
  const crs: (number | null)[] = [];
  for (const s of plan) {
    const cand = byId.get(s.ruleEntryId);
    for (let i = 0; i < s.count; i++) crs.push(cand ? cand.cr : null);
  }
  return crs;
}

/** Total number of creatures across a plan. */
function totalCopies(plan: RosterSlotPlan[]): number {
  return plan.reduce((n, s) => n + s.count, 0);
}

/**
 * Pick the best {candidate, count} to fill ONE slot, given the CRs already contributed by the
 * other slots (`fixedCrs`). Reuses computeEncounterDifficulty over the COMBINED roster so the
 * group-size multiplier is applied to the whole fight, not per slot. Deterministic by `seed`:
 * the first (in seeded order) combination whose whole-roster band equals the target wins; else
 * the closest by band distance then by adjusted-XP gap to the target threshold. Returns null
 * when there are no usable candidates or no room left (maxSlotCount <= 0).
 */
function fillSlot(
  fixedCrs: (number | null)[],
  partyLevels: number[],
  targetBand: DifficultyBand,
  usable: GeneratorCandidate[],
  maxSlotCount: number,
  shape: EncounterShape | undefined,
  seed: number,
): GeneratorPick | null {
  if (usable.length === 0 || maxSlotCount < 1) return null;
  const rng = mulberry32(seed);
  const [rawMin, rawMax] = shapeCountRange(shape, maxSlotCount);
  const countMin = Math.max(1, Math.min(rawMin, maxSlotCount));
  const countMax = Math.max(countMin, Math.min(rawMax, maxSlotCount));
  const thresholds = computeEncounterDifficulty(partyLevels, []).thresholds;
  const targetXp =
    targetBand === 'trivial'
      ? Math.max(1, Math.floor(thresholds.easy / 2))
      : thresholds[targetBand as 'easy' | 'medium' | 'hard' | 'deadly'];

  const shuffled = seededShuffle(usable, rng);
  let best: { pick: GeneratorPick; score: number; xpGap: number } | null = null;
  for (const m of shuffled) {
    for (let n = countMin; n <= countMax; n++) {
      const crs = [...fixedCrs, ...Array.from({ length: n }, () => m.cr)];
      const difficulty = computeEncounterDifficulty(partyLevels, crs);
      if (difficulty.band === targetBand) {
        return { ...m, count: n };
      }
      const score = bandDistanceOrMax(difficulty.band, targetBand);
      const xpGap = Math.abs(difficulty.adjustedXp - targetXp);
      if (best === null || score < best.score || (score === best.score && xpGap < best.xpGap)) {
        best = { pick: { ...m, count: n }, score, xpGap };
      }
    }
  }
  return best ? best.pick : null;
}

/** Next free `s<N>` slot id for a plan. */
function nextSlotId(plan: RosterSlotPlan[]): string {
  let max = 0;
  for (const s of plan) {
    const m = /^s(\d+)$/.exec(s.slotId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

/** CRs contributed by every slot EXCEPT the one at `exceptIndex`. */
function fixedCrsExcept(plan: RosterSlotPlan[], exceptIndex: number, byId: Map<number, GeneratorCandidate>): (number | null)[] {
  return crsForPlan(
    plan.filter((_, i) => i !== exceptIndex),
    byId,
  );
}

/**
 * Build or tune a multi-slot encounter roster (issue #412). With no `plan`/`tune` it freshly
 * generates a single primary slot (identical to the #304 generator). With a `tune` op it applies
 * the deterministic operation to the supplied plan. Always returns the normalized plan (to
 * round-trip), the resolved picks, and the whole-roster #58 difficulty.
 */
export function buildEncounterRoster(opts: BuildRosterOptions): BuildRosterResult {
  const { partyLevels, targetBand, candidates, maxCount, shape } = opts;
  const byId = new Map<number, GeneratorCandidate>(candidates.map((c) => [c.ruleEntryId, c]));
  const usable = candidates.filter((c) => c.xp > 0);
  let masterSeed = opts.seed >>> 0;
  let plan: RosterSlotPlan[] = (opts.plan ?? []).map((s) => ({ ...s }));

  const finalize = (): BuildRosterResult => {
    // Drop slots whose creature no longer resolves AND that carry no count, keep others so the
    // missing-statblock warning can surface. Recompute picks + difficulty over the whole roster.
    const picks: GeneratorPick[] = plan.map((s) => {
      const cand = byId.get(s.ruleEntryId);
      return cand
        ? { ...cand, count: s.count }
        : { ruleEntryId: s.ruleEntryId, name: '', entryType: 'monster' as const, cr: null, xp: 0, hpMax: null, count: s.count };
    });
    const difficulty = computeEncounterDifficulty(partyLevels, crsForPlan(plan, byId));
    const count = totalCopies(plan);
    return {
      plan,
      picks,
      difficulty,
      shape: shape ?? shapeForCount(count),
      seed: masterSeed,
      matchedBand: difficulty.band === targetBand,
    };
  };

  // Fresh generation: no existing plan and no tune op -> assemble the primary slot.
  if (!opts.tune && (!opts.plan || opts.plan.length === 0)) {
    const pick = fillSlot([], partyLevels, targetBand, usable, maxCount, shape, masterSeed);
    plan = pick ? [{ slotId: 's1', ruleEntryId: pick.ruleEntryId, count: pick.count, pinned: false, seed: masterSeed }] : [];
    return finalize();
  }

  const tune = opts.tune;
  if (!tune) return finalize();

  switch (tune.op) {
    case 'reroll-all': {
      const newSeed = (tune.seed ?? deriveSeed(masterSeed, 0x9e3779b9)) >>> 0;
      masterSeed = newSeed;
      const rebuilt: RosterSlotPlan[] = [];
      // Keep pinned slots verbatim; refill each non-pinned slot against the pinned + already
      // refilled context so the whole roster converges on the target band.
      const pinned = plan.filter((s) => s.pinned);
      let idx = 0;
      for (const s of plan) {
        if (s.pinned) {
          rebuilt.push({ ...s });
          continue;
        }
        const fixed = crsForPlan([...pinned, ...rebuilt.filter((r) => !r.pinned)], byId);
        const used = totalCopies([...pinned, ...rebuilt.filter((r) => !r.pinned)]);
        const slotSeed = deriveSeed(newSeed, idx + 1);
        const pick = fillSlot(fixed, partyLevels, targetBand, usable, Math.max(1, maxCount - used), shape, slotSeed);
        if (pick) rebuilt.push({ slotId: s.slotId, ruleEntryId: pick.ruleEntryId, count: pick.count, pinned: false, seed: slotSeed });
        idx++;
      }
      plan = rebuilt;
      break;
    }
    case 'reroll-slot': {
      const i = plan.findIndex((s) => s.slotId === tune.slotId);
      if (i >= 0 && !plan[i].pinned) {
        const slotSeed = (tune.seed ?? deriveSeed(plan[i].seed, i + 1)) >>> 0;
        const used = totalCopies(plan) - plan[i].count;
        const pick = fillSlot(fixedCrsExcept(plan, i, byId), partyLevels, targetBand, usable, Math.max(1, maxCount - used), shape, slotSeed);
        if (pick) plan[i] = { ...plan[i], ruleEntryId: pick.ruleEntryId, count: pick.count, seed: slotSeed };
      }
      break;
    }
    case 'swap-slot': {
      const i = plan.findIndex((s) => s.slotId === tune.slotId);
      if (i >= 0 && byId.has(tune.ruleEntryId)) {
        const used = totalCopies(plan) - plan[i].count;
        const count = Math.max(1, Math.min(plan[i].count, Math.max(1, maxCount - used)));
        plan[i] = { ...plan[i], ruleEntryId: tune.ruleEntryId, count };
      }
      break;
    }
    case 'adjust-count': {
      const i = plan.findIndex((s) => s.slotId === tune.slotId);
      if (i >= 0) {
        const used = totalCopies(plan) - plan[i].count;
        plan[i] = { ...plan[i], count: Math.max(1, Math.min(tune.count, Math.max(1, maxCount - used))) };
      }
      break;
    }
    case 'pin': {
      const i = plan.findIndex((s) => s.slotId === tune.slotId);
      if (i >= 0) plan[i] = { ...plan[i], pinned: tune.pinned };
      break;
    }
    case 'add-slot': {
      const slotSeed = (tune.seed ?? deriveSeed(masterSeed, plan.length + 1)) >>> 0;
      const used = totalCopies(plan);
      const pick = fillSlot(crsForPlan(plan, byId), partyLevels, targetBand, usable, Math.max(1, maxCount - used), shape, slotSeed);
      if (pick) plan.push({ slotId: nextSlotId(plan), ruleEntryId: pick.ruleEntryId, count: pick.count, pinned: false, seed: slotSeed });
      break;
    }
    case 'remove-slot': {
      plan = plan.filter((s) => s.slotId !== tune.slotId);
      break;
    }
  }
  return finalize();
}

/**
 * Derive the actionable roster warnings a preview surfaces (issue #412): role duplication,
 * action-economy imbalance, missing statblocks, unsupported-system math, an unknown budget, a
 * swingy fight, an empty roster, and a best-effort band miss. Pure over the resolved picks +
 * party + already-computed difficulty; adds no new math. Ordered most-severe-ish first.
 */
export function deriveEncounterRosterWarnings(
  picks: GeneratorPick[],
  partyLevels: number[],
  difficulty: EncounterDifficulty,
  matchedBand: boolean,
  targetBand: DifficultyBand,
): EncounterWarning[] {
  const warnings: EncounterWarning[] = [];
  const monsterCount = picks.reduce((n, p) => n + p.count, 0);
  const partySize = partyLevels.length;

  if (picks.length === 0) {
    warnings.push({ code: 'empty-roster', severity: 'warn', message: 'No creatures selected yet — add or reroll a slot to build the encounter.' });
  }

  if (difficulty.status === 'unsupported') {
    warnings.push({
      code: 'unsupported-system',
      severity: 'warn',
      message: difficulty.warnings[0] ?? 'This rule system has no built-in encounter budget, so difficulty cannot be estimated.',
    });
  } else if (difficulty.status === 'unknown') {
    warnings.push({
      code: 'difficulty-unknown',
      severity: 'warn',
      message: 'The selected creatures have no CR/XP, so the difficulty cannot be scored — add ratings to their statblocks.',
    });
  }

  // Missing statblock: a picked creature with no resolvable HP or CR.
  const missing = picks.filter((p) => p.hpMax === null || p.cr === null);
  if (missing.length > 0) {
    const names = missing.map((p) => p.name || `#${p.ruleEntryId}`).slice(0, 5).join(', ');
    warnings.push({
      code: 'missing-statblock',
      severity: 'warn',
      message: `${missing.length} creature${missing.length === 1 ? '' : 's'} lack HP/CR data (${names}) — HP or difficulty may be incomplete.`,
    });
  }

  // Role duplication: the same statblock across two or more distinct slots.
  const idCounts = new Map<number, number>();
  for (const p of picks) idCounts.set(p.ruleEntryId, (idCounts.get(p.ruleEntryId) ?? 0) + 1);
  const dupes = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    warnings.push({
      code: 'role-duplication',
      severity: 'info',
      message: 'The same statblock fills more than one slot — consider swapping one for variety in roles/tactics.',
    });
  }

  // Action economy: a lone monster against a full party, or a swarm that badly outnumbers it.
  if (partySize > 0 && monsterCount > 0) {
    if (monsterCount === 1 && partySize >= 3) {
      warnings.push({
        code: 'action-economy',
        severity: 'info',
        message: `A single monster takes one turn per round against ${partySize} PCs — it may be focus-fired down before acting much. Add minions or legendary actions.`,
      });
    } else if (monsterCount >= partySize * 3) {
      warnings.push({
        code: 'action-economy',
        severity: 'warn',
        message: `${monsterCount} monsters vs ${partySize} PCs is a heavy action-economy imbalance — the party may be overwhelmed regardless of the XP band.`,
      });
    }
  }

  // Swinginess: a lone big creature (high variance), or a fight well past Deadly.
  if (difficulty.status === 'ok') {
    if (monsterCount > 0 && monsterCount <= 1 && (difficulty.band === 'hard' || difficulty.band === 'deadly')) {
      warnings.push({
        code: 'swinginess',
        severity: 'info',
        message: 'A single high-threat creature makes the fight swingy — one lucky crit or failed save can decide it. Consider splitting the budget across two creatures.',
      });
    } else if (difficulty.adjustedXp >= Math.round(difficulty.thresholds.deadly * 1.5) && difficulty.thresholds.deadly > 0) {
      warnings.push({
        code: 'swinginess',
        severity: 'warn',
        message: 'Adjusted XP is well above the Deadly threshold — this fight risks a TPK. Reduce counts or pick weaker creatures unless a lethal set-piece is intended.',
      });
    }
  }

  if (!matchedBand && picks.length > 0 && difficulty.status === 'ok') {
    warnings.push({
      code: 'band-miss',
      severity: 'info',
      message: `The compendium could not field an exact "${targetBand}" group for this party — the closest achievable roster is shown (${difficulty.label}).`,
    });
  }

  return warnings;
}
