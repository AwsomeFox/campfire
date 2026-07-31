/**
 * Short rest / long rest — data model + pure, system-aware recovery math (issue #1041).
 *
 * ── What was actually here before ─────────────────────────────────────────────────────
 * The issue reports "zero hits for short rest / long rest". That is not quite right, and the
 * difference matters: the repo already had TWO rest implementations with overlapping
 * vocabulary and divergent semantics.
 *
 *   - `CharactersService.rest(id, 'stamina'|'night'|'short'|'long')` — WIRED, behind
 *     `POST /characters/:id/rest`. Restores SP/RP and heals HP equal to character level. It
 *     accepts the words `short` and `long` and treats them as aliases for the Starfinder
 *     stamina/night cadence, and it ignores spell slots, resources, and conditions entirely.
 *   - `CharactersService.restCharacter(id, 'short-rest'|'long-rest'|'refocus')` — DEAD CODE.
 *     Resets spell slots and resources by their `recharge` tag, and ignores HP, temp HP,
 *     death state, and conditions.
 *
 * So a DM who called the one real rest endpoint with `{"kind":"long"}` got a silent PARTIAL
 * rest: no spell slots, no class resources, no conditions, and HP healed by level rather than
 * to full. That is worse than the absence the issue describes, because it looks like it worked.
 * The deliverable here is therefore ONE recovery model both of those delegate to — not a third
 * implementation alongside them.
 *
 * ── The rule-system seam already existed too ──────────────────────────────────────────
 * `AdapterResourceDef.recharge` has been `'short-rest' | 'long-rest' | 'refocus' | 'dawn' |
 * 'turn-start' | 'special'` since issue #422, and the 5e and PF2e adapters already tag their
 * resources with it (`actionSurge: short-rest`, `rage: long-rest`, `focusPoints: refocus`).
 * Nobody ever wrote the consumer. So "the rule-system adapter customises recovery" is served
 * by CONSUMING an existing declaration rather than by inventing a parallel one — which also
 * means the six adapters that declare no resources correctly recover nothing rather than
 * silently inheriting 5e's cadence.
 *
 * ── Everything here is pure ───────────────────────────────────────────────────────────
 * No I/O, no clock, no RNG: dice come from an injected roller, exactly like `rollActionDice`
 * and the #414 action resolver. That is what lets the atomicity requirement be met honestly —
 * the caller PLANS every character's rest first, validates the whole plan, and only then opens
 * one transaction to apply it. A rest that half-applies is worse than no rest tool at all.
 */
import { z } from 'zod';
import { leveledConditionTrackFor } from './leveled-conditions';

// ---------------------------------------------------------------------------
// Rule-system seam (structural — no runtime import of index.ts, so no cycle).
// ---------------------------------------------------------------------------

/** The recharge cadences a resource can declare (mirrors `AdapterResourceDef.recharge`). */
export type RestRechargeCadence = 'short-rest' | 'long-rest' | 'refocus' | 'dawn' | 'turn-start' | 'special';

/** Which rest is being taken. */
export type RestKind = 'short' | 'long';

/**
 * The current party-recovery wire format.  `custom` is intentionally narrow: it
 * only restores resource pools the DM names.  It never guesses at HP, slots, or
 * conditions, which are rule-specific state rather than generic "reset" data.
 */
const PartyRecoveryBase = { characterIds: z.array(z.number().int().positive()).min(1) };
export const PartyRecoveryRequest = z.discriminatedUnion('kind', [
  z.object({ ...PartyRecoveryBase, kind: z.literal('short'), perCharacter: z.record(z.string(), z.object({ spendHitDice: z.number().int().min(0).optional(), hitDie: z.number().int().min(2).max(100).optional() })).default({}) }),
  z.object({ ...PartyRecoveryBase, kind: z.literal('long') }),
  z.object({ ...PartyRecoveryBase, kind: z.literal('custom'), customResourceKeys: z.array(z.string().min(1).max(80)).min(1) }),
]).superRefine((value, ctx) => { if (new Set(value.characterIds).size !== value.characterIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'characterIds must be unique' }); if (value.kind === 'short') for (const key of Object.keys(value.perCharacter)) if (!/^[1-9]\d*$/.test(key) || !value.characterIds.includes(Number(key))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'perCharacter keys must be selected canonical character IDs' }); if (value.kind === 'custom' && new Set(value.customResourceKeys).size !== value.customResourceKeys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'customResourceKeys must be unique' }); });
export type PartyRecoveryRequest = z.infer<typeof PartyRecoveryRequest>;

/** Apply adds the preview token and a client-generated idempotency key. */
export const PartyRecoveryApplyRequest = z.object({
  previewToken: z.string().min(1).max(128),
  idempotencyKey: z.string().min(8).max(200),
  acknowledgeRunningCombatants: z.boolean().default(false),
});
export type PartyRecoveryApplyRequest = z.infer<typeof PartyRecoveryApplyRequest>;

export const PartyRecoveryUndoRequest = z.object({ idempotencyKey: z.string().min(8).max(200) });
export type PartyRecoveryUndoRequest = z.infer<typeof PartyRecoveryUndoRequest>;

/** Exact, UI-friendly before/after deltas.  Stored plans use the same shape. */
export interface PartyRecoveryCharacterDelta {
  characterId: number;
  name: string;
  hp: { before: number; after: number; tempBefore: number; tempAfter: number };
  deathState: { before: RestCharacterState['deathState']; after: RestCharacterState['deathState'] };
  spellSlots: Record<string, { before: number; after: number }>;
  resources: Record<string, { before: number; after: number }>;
  conditionsCleared: string[];
  conditionsKept: string[];
  hitDiceSpent: number;
  hitDiceRolls: number[];
}

export interface PartyRecoveryPreview {
  previewToken: string;
  request: PartyRecoveryRequest;
  ruleSystem: string;
  characters: PartyRecoveryCharacterDelta[];
  failures: RestPlanFailure[];
  runningCombatantCharacterIds: number[];
}

/**
 * Does a rest of this kind refill a resource with this cadence?
 *
 * EXHAUSTIVE `Record<RestKind, Record<RestRechargeCadence, boolean>>` on purpose, and not a
 * `Set` or a chain of `||`. The dead `restCharacter` used exactly such a chain, and it is
 * instructive about how that fails: it recharged `refocus` resources on a SHORT rest (a PF2e
 * Refocus is a deliberate 10-minute activity, not something a short rest hands you), and it
 * recharged untagged resources on a long rest via a `!r.recharge` clause buried mid-condition.
 * With a Record, every cadence must be answered for every rest kind, in writing, and adding a
 * seventh cadence is a compile error at the one table that decides what comes back.
 */
export const RECHARGE_RECOVERED_BY_REST: Record<RestKind, Record<RestRechargeCadence, boolean>> = {
  short: {
    'short-rest': true,
    // A short rest is not a long rest. This is the whole point of the distinction.
    'long-rest': false,
    // Refocus is its own activity in the systems that have it. A short rest does not grant it.
    refocus: false,
    dawn: false,
    'turn-start': false,
    special: false,
  },
  long: {
    // A long rest subsumes a short rest's recovery.
    'short-rest': true,
    'long-rest': true,
    // A night's rest gives you your focus back in every system that models both.
    refocus: true,
    // "Comes back at dawn" and "comes back on a long rest" coincide for a normal overnight
    // rest. A system where they genuinely differ should model that as `special`.
    dawn: true,
    // Per-turn recharges are an encounter-scoped mechanic; the turn tracker owns them, and a
    // rest neither needs nor is allowed to touch them.
    'turn-start': false,
    // `special` means "this comes back on a condition the system did not model here". A rest
    // must not guess: the DM restores it deliberately.
    special: false,
  },
};

/**
 * What a rest does with a resource that carries NO `recharge` tag.
 *
 * A homebrew resource a player typed onto their sheet has no cadence. `resourceVocabularyForAdapter`
 * already normalizes an unparseable cadence to `'long-rest'`, so treating an ABSENT one the same
 * way keeps the two paths agreeing. Stated as a named constant rather than an inline `?? ` so the
 * choice is visible: an untagged resource comes back on a long rest and not on a short one.
 */
export const UNTAGGED_RESOURCE_CADENCE: RestRechargeCadence = 'long-rest';

/**
 * OPTIONAL per-system rest customisation, hung off `RuleSystemAdapter` as `restModel`.
 *
 * Every field is optional and every DEFAULT IS CONSERVATIVE, because eight adapters ship in
 * this repo and only two of them declare any resource vocabulary at all. An adapter that says
 * nothing here gets: HP to full on a long rest, resources by their declared cadence, NO
 * condition clearing, and NO hit-dice mechanic. That is the honest floor — a 13th Age or
 * Ironsworn table should not silently inherit 5e's recovery because 5e is the fallback adapter.
 */
export const RestModel = z.object({
  /**
   * Conditions this system's LONG rest removes, by name (matched case-insensitively).
   *
   * An ALLOWLIST of what a rest clears — deliberately not a denylist of what is "permanent".
   * Character conditions are a bare `string[]` with no duration, source, or permanence metadata
   * (issue #1047), and the vocabulary is per-adapter and user-extensible. A denylist would
   * therefore fail OPEN: any condition the list did not anticipate — a homebrew "cursed",
   * "lycanthropy", "level drain", or a DM's freeform note — would be silently deleted by a
   * night's sleep, destroying table state a human deliberately set. An allowlist fails CLOSED:
   * an unrecognised condition SURVIVES the rest and a human decides what to do with it. Being
   * wrong in the direction of "you still have that condition, go look at it" is recoverable;
   * being wrong the other way is invisible.
   *
   * The applier reports both what it cleared and what it kept, so the DM never has to infer it.
   */
  clearedByLongRest: z.array(z.string().max(40)).default([]),
  /** Conditions this system's SHORT rest removes. Usually empty. */
  clearedByShortRest: z.array(z.string().max(40)).default([]),
  /**
   * Default hit-die size for spending hit dice on a short rest, when the character's own class
   * cannot supply one. `null` means this system has no hit-dice mechanic, and a short rest that
   * asks to spend hit dice is REJECTED rather than served with an invented die.
   */
  defaultHitDie: z.number().int().min(2).max(100).nullable().default(null),
  /**
   * How many spent hit dice a long rest gives back, as a fraction of the character's maximum.
   * 5e returns half (minimum one). `1` returns all of them. Applied only to the resource keyed
   * {@link HIT_DICE_RESOURCE_KEY}, which both the 5e and PF2e adapters already declare.
   */
  longRestHitDiceFraction: z.number().min(0).max(1).default(1),
  /** Whether a long rest resets 5e-style death-save progress and revives a `dying`/`stable` PC. */
  longRestClearsDeathSaves: z.boolean().default(true),
});
export type RestModel = z.infer<typeof RestModel>;

/** The conservative model an adapter that declares nothing gets. */
export const NEUTRAL_REST_MODEL: RestModel = RestModel.parse({});

/**
 * The resource key both the 5e and PF2e adapters already use for hit dice / stamina.
 * Named here so the hit-dice rules key off ONE string rather than a literal in three files.
 */
export const HIT_DICE_RESOURCE_KEY = 'hitDice';

export interface RestOptionDef {
  /** The rest type passed to POST /characters/:id/rest. */
  readonly type: 'short' | 'long' | 'stamina' | 'night';
  /** Human label shown on the button, e.g. "Short Rest", "Long Rest", "Stamina Rest (1 RP)", "Night's Rest". */
  readonly label: string;
  /** Hover tooltip / description. */
  readonly description?: string;
}

export const DEFAULT_GENERIC_REST_OPTIONS: readonly RestOptionDef[] = [
  { type: 'short', label: 'Short Rest', description: 'Take a short rest (1 hour)' },
  { type: 'long', label: 'Long Rest', description: 'Take a long rest (8 hours)' },
];

export const DEFAULT_STARFINDER_REST_OPTIONS: readonly RestOptionDef[] = [
  { type: 'stamina', label: '⚡ Stamina Rest (1 RP)', description: 'Spend 1 RP to restore full Stamina Points (10-min rest)' },
  { type: 'night', label: "🌙 Night's Rest", description: "Full Night's Rest (8 hours) — restores full SP, RP, and HP equal to Level" },
];

export function restOptionsForAdapter(adapter: { id: string; restOptions?: readonly RestOptionDef[] }): readonly RestOptionDef[] {
  if (adapter.restOptions) return adapter.restOptions;
  if (adapter.id === 'starfinder-1e') return DEFAULT_STARFINDER_REST_OPTIONS;
  return DEFAULT_GENERIC_REST_OPTIONS;
}

/** The minimal adapter surface this module reads. The real `RuleSystemAdapter` satisfies it. */
export interface RestAdapter {
  readonly id: string;
  /** Ability-score → modifier; used for the CON bonus on a spent hit die. */
  abilityModifier(score: number): number;
  readonly restModel?: RestModel;
  readonly restOptions?: readonly RestOptionDef[];
  readonly resources?: readonly { key: string; name: string; recharge: RestRechargeCadence; defaultMax?: number }[];
}

/** Resolve an adapter's rest model, falling back to the conservative neutral one. */
export function restModelForAdapter(adapter: Pick<RestAdapter, 'restModel'>): RestModel {
  return adapter.restModel ?? NEUTRAL_REST_MODEL;
}


// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/**
 * The minimal per-condition shape this module reads (issue #1641) — a NAME plus its `stacks`
 * count. Mirrors `ConditionInstance.name` / `.stacks` structurally, declared locally rather than
 * imported so this module keeps no runtime dependency on index.ts (same reasoning as
 * `ResolverAdapter` in action-resolver.ts — `ConditionInstance` embeds nothing that would cycle
 * back here, but the convention is to declare the narrow slice each module actually reads).
 * `stacks` is what lets 5e exhaustion be a plain condition instance instead of a dedicated
 * `exhaustionLevel` column (see apps/server/src/common/conditions.ts) — and therefore the only
 * way a rest can tell "exhaustion 5" from "exhaustion 1" well enough to drop it by one.
 */
export interface RestConditionState {
  readonly name: string;
  readonly stacks: number;
}

/** The slice of a character this module needs. Mirrors the stored columns, nothing more. */
export interface RestCharacterState {
  id: number;
  name: string;
  level: number;
  hpCurrent: number;
  hpMax: number;
  hpTemp: number;
  deathState: 'none' | 'dying' | 'stable' | 'dead';
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  conditions: readonly RestConditionState[];
  /** Ability scores, e.g. `{ CON: 14 }`. Used only for the hit-die CON bonus. */
  stats: Readonly<Record<string, number>>;
  spellSlots: Readonly<Record<string, { max: number; used: number }>>;
  resources: Readonly<Record<string, { max: number; used: number; name?: string; recharge?: string }>>;
}

/** Per-character options for a rest. */
export interface RestCharacterOptions {
  /** Short rest only: how many hit dice this character spends. 0 / omitted spends none. */
  spendHitDice?: number;
  /**
   * Short rest only: the die size to roll per spent hit die (e.g. 8 for a d8). When omitted the
   * adapter's `defaultHitDie` is used; when THAT is null and dice were requested, planning fails.
   */
  hitDie?: number;
}

/** Why a character's rest could not be planned. Planning fails BEFORE anything is written. */
export type RestPlanError =
  /** Hit dice were requested but neither the call nor the adapter supplies a die size. */
  | 'hit_die_unknown'
  /** Hit dice were requested but this system has no hit-dice mechanic at all. */
  | 'hit_dice_unsupported'
  /** More hit dice were requested than the character has left. */
  | 'insufficient_hit_dice'
  /** A dead character does not rest. */
  | 'character_dead';

export interface RestPlanFailure {
  characterId: number;
  characterName: string;
  error: RestPlanError;
  detail: string;
}

/** The computed, not-yet-applied result for one character. */
export interface CharacterRestPlan {
  characterId: number;
  characterName: string;
  hpBefore: number;
  hpAfter: number;
  hpTempAfter: number;
  deathStateAfter: 'none' | 'dying' | 'stable' | 'dead';
  deathSaveSuccessesAfter: number;
  deathSaveFailuresAfter: number;
  /** Full replacement blobs, ready to persist. */
  spellSlotsAfter: Record<string, { max: number; used: number }>;
  resourcesAfter: Record<string, { max: number; used: number; name?: string; recharge?: string }>;
  /**
   * Every condition that SURVIVES the rest — unchanged AND decremented — with its post-rest
   * `stacks` (issue #1641). A condition decremented to 0 stacks does not appear here; it moved
   * to {@link conditionsCleared} instead, since "exhaustion 1 → long rest" removes the condition
   * exactly the same as an outright clear does.
   */
  conditionsAfter: RestConditionState[];
  /**
   * Conditions the rest removed OUTRIGHT, in the casing they were stored in — either because the
   * adapter's `clearedBy*Rest` allowlist named them, or because a `decrementedBy*Rest` condition's
   * stacks hit 0. The caller does not need to know which: either way the condition is gone.
   */
  conditionsCleared: string[];
  /**
   * Conditions the rest deliberately LEFT in place — unchanged AND decremented-but-still-present.
   * Surfaced so a DM sees what a night's sleep did not (fully) fix rather than having to diff two
   * sheets. See {@link conditionsDecremented} for which of these actually moved.
   */
  conditionsKept: string[];
  /**
   * The subset of `conditionsKept` whose `stacks` the rest reduced by one (issue #1641) — 5e
   * exhaustion's "drops a level" rule. Empty for every condition that was merely left alone.
   */
  conditionsDecremented: { name: string; stacksBefore: number; stacksAfter: number }[];
  /** Resource keys refilled, and the spell-slot levels refilled. */
  resourcesRecovered: string[];
  spellSlotLevelsRecovered: string[];
  /** Short rest: how many hit dice were spent and what they rolled. */
  hitDiceSpent: number;
  hitDiceRolls: number[];
  /** Long rest: how many spent hit dice were returned. */
  hitDiceRecovered: number;
}

/** The whole party's plan. `failures` non-empty means NOTHING should be applied. */
export interface RestPlan {
  kind: RestKind | 'custom';
  ruleSystem: string;
  plans: CharacterRestPlan[];
  failures: RestPlanFailure[];
}

/** Injected dice roller: given a die size, return a face. Deterministic in tests. */
export type RestDieRoller = (sides: number) => number;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function normalizeCondition(name: string): string {
  return name.trim().toLowerCase();
}

/** What a rest does to one named condition: remove it, reduce its stacks by one, or leave it. */
export type RestConditionOutcome = 'clear' | 'decrement' | 'keep';

/**
 * Does a rest of `kind` clear, decrement, or leave this condition under this adapter?
 *
 * SEAM FOR ISSUE #1047. Today `clear` is a name match against the adapter's allowlist, because a
 * character's conditions are bare strings with no duration or source. When #1047 gives sheet
 * conditions the metadata combatants already have (`ConditionInstance.durationRounds` /
 * `source` / `isConcentration`), THIS function is the single place that has to learn about it —
 * every caller already asks the question in these terms. The allowlist then becomes the
 * fallback for conditions that still carry no instance data, rather than being replaced.
 *
 * REPLACES the boolean `isClearedByRest` (issue #1641): a plain "cleared or not" cannot express
 * 5e's actual long-rest rule for exhaustion — "reduces exhaustion by one level", not "removes
 * exhaustion" — so a long rest was wiping a character from exhaustion 5 straight to 0.
 *
 * `decrement` is NOT a second `RestModel` allowlist. It asks `leveledConditionTrackFor(adapterId)`
 * (issue #1643) — the existing, adapter-owned lookup of which ONE condition (if any) a system
 * models as an escalating level rather than present/absent, keyed by adapter id so it needs no
 * field on `RuleSystemAdapter`'s own (large, concurrently-edited) object literals. Reusing it
 * here rather than inventing a parallel `decrementedByLongRest` allowlist is deliberate: two
 * representations of "which condition is this system's leveled one" would be exactly the
 * sibling-divergence this codebase keeps being burned by. `leveledConditionTrackFor('pf2e')` is
 * `undefined` — PF2e has no exhaustion track — so `decrement` can never fire for it; every
 * adapter that has not declared a track behaves exactly as before this issue. A LONG rest is the
 * only rest kind checked because 5e's rule (the only leveled track that exists today) is a long-
 * rest-only recovery; nothing here stops a future track from differing, since `kind` is already
 * a parameter and the check is one `if`, not a hardcoded assumption.
 *
 * `clear` is checked FIRST and wins if a condition name were ever (accidentally) listed in both
 * an adapter's `clearedByLongRest` and its leveled-condition track: a full clear must never be
 * silently downgraded to a one-stack decrement.
 */
export function restConditionOutcome(condition: string, kind: RestKind, model: RestModel, adapterId: string): RestConditionOutcome {
  const target = normalizeCondition(condition);
  if (!target) return 'keep';
  const clearedList = kind === 'long' ? model.clearedByLongRest : model.clearedByShortRest;
  if (clearedList.some((c) => normalizeCondition(c) === target)) return 'clear';
  if (kind === 'long') {
    const track = leveledConditionTrackFor(adapterId);
    if (track && normalizeCondition(track.name) === target) return 'decrement';
  }
  return 'keep';
}

/**
 * Reset spell slots for a rest.
 *
 * SEAM FOR ISSUE #1039. Slots are a flat `Record<"1".."9", {max, used}>` today, so a long rest
 * simply zeroes `used` at every level and a short rest touches nothing. When #1039 introduces
 * slot classes (pact magic recovering on a SHORT rest, spell points, per-class pools), only
 * this function changes — it already receives the rest kind, so its signature does not.
 */
export function resetSpellSlotsForRest(
  slots: Readonly<Record<string, { max: number; used: number }>>,
  kind: RestKind,
): { slots: Record<string, { max: number; used: number }>; levelsRecovered: string[] } {
  const next: Record<string, { max: number; used: number }> = {};
  const levelsRecovered: string[] = [];
  for (const [level, slot] of Object.entries(slots)) {
    // A short rest recovers no ordinary spell slots in any system modelled here (5e pact magic
    // is #1039's problem, and inventing it now would hand every 5e caster free slots).
    if (kind === 'long' && slot.used > 0) {
      levelsRecovered.push(level);
      next[level] = { max: slot.max, used: 0 };
    } else {
      next[level] = { max: slot.max, used: slot.used };
    }
  }
  return { slots: next, levelsRecovered };
}

/** Plan ONE character's rest. Pure; returns either a plan or a failure, never both. */
export function planCharacterRest(
  adapter: RestAdapter,
  character: RestCharacterState,
  kind: RestKind,
  options: RestCharacterOptions,
  roll: RestDieRoller,
): { plan: CharacterRestPlan } | { failure: RestPlanFailure } {
  const model = restModelForAdapter(adapter);
  const fail = (error: RestPlanError, detail: string): { failure: RestPlanFailure } => ({
    failure: { characterId: character.id, characterName: character.name, error, detail },
  });

  // A dead character is not resting. Silently "resting" a corpse back to full HP would be the
  // single most destructive thing an atomic party-wide tool could do.
  if (character.deathState === 'dead') {
    return fail('character_dead', `${character.name} is dead and cannot benefit from a rest.`);
  }

  // ── hit dice (short rest) ────────────────────────────────────────────────────────────
  const requestedDice = Math.max(0, Math.trunc(options.spendHitDice ?? 0));
  let hitDiceSpent = 0;
  const hitDiceRolls: number[] = [];
  let hitDiceHealing = 0;

  if (requestedDice > 0) {
    if (kind !== 'short') {
      return fail('hit_dice_unsupported', 'Hit dice are spent on a short rest, not a long rest.');
    }
    const die = options.hitDie ?? model.defaultHitDie;
    if (die === null || die === undefined) {
      // Refusing beats guessing. A character's hit-die SIZE is not stored on the sheet
      // anywhere in this repo — it exists only on imported class compendium entries, which a
      // campaign may not have installed. Inventing a d8 for a barbarian silently under-heals
      // them and nobody can tell from the result that it happened.
      return fail(
        'hit_die_unknown',
        `No hit-die size is known for ${character.name}. Pass an explicit hitDie (e.g. 8 for a d8).`,
      );
    }
    const pool = character.resources[HIT_DICE_RESOURCE_KEY];
    const available = pool ? Math.max(0, pool.max - pool.used) : 0;
    if (requestedDice > available) {
      return fail(
        'insufficient_hit_dice',
        `${character.name} has ${available} hit ${available === 1 ? 'die' : 'dice'} available but ${requestedDice} were requested.`,
      );
    }
    const conMod = adapter.abilityModifier(character.stats.CON ?? 10);
    for (let i = 0; i < requestedDice; i++) {
      const face = roll(die);
      hitDiceRolls.push(face);
      // A hit die never heals less than 0 even with a punishing CON penalty.
      hitDiceHealing += Math.max(0, face + conMod);
    }
    hitDiceSpent = requestedDice;
  }

  // ── hit points ───────────────────────────────────────────────────────────────────────
  const hpAfter =
    kind === 'long'
      ? character.hpMax
      : Math.min(character.hpMax, character.hpCurrent + hitDiceHealing);

  // Temp HP is a granted buffer, not stored health: it expires on a long rest in every system
  // modelled here, and a short rest leaves it alone.
  const hpTempAfter = kind === 'long' ? 0 : character.hpTemp;

  // ── death saves ──────────────────────────────────────────────────────────────────────
  let deathStateAfter = character.deathState;
  let deathSaveSuccessesAfter = character.deathSaveSuccesses;
  let deathSaveFailuresAfter = character.deathSaveFailures;
  if (kind === 'long' && model.longRestClearsDeathSaves) {
    deathStateAfter = 'none';
    deathSaveSuccessesAfter = 0;
    deathSaveFailuresAfter = 0;
  } else if (hpAfter > 0 && (character.deathState === 'dying' || character.deathState === 'stable')) {
    // Healed above 0 by hit dice — a dying character stabilises and stands up.
    deathStateAfter = 'none';
    deathSaveSuccessesAfter = 0;
    deathSaveFailuresAfter = 0;
  }

  // ── spell slots ──────────────────────────────────────────────────────────────────────
  const { slots: spellSlotsAfter, levelsRecovered } = resetSpellSlotsForRest(character.spellSlots, kind);

  // ── resources ────────────────────────────────────────────────────────────────────────
  const resourcesAfter: CharacterRestPlan['resourcesAfter'] = {};
  const resourcesRecovered: string[] = [];
  let hitDiceRecovered = 0;

  for (const [key, res] of Object.entries(character.resources)) {
    const cadence = (res.recharge as RestRechargeCadence | undefined) ?? UNTAGGED_RESOURCE_CADENCE;
    const recovers = RECHARGE_RECOVERED_BY_REST[kind][cadence] ?? false;
    const next = { ...res };

    if (key === HIT_DICE_RESOURCE_KEY) {
      // Hit dice are the one resource a rest both SPENDS and RETURNS, so they are handled
      // explicitly rather than by the generic cadence rule.
      let used = res.used;
      if (kind === 'short') {
        used = Math.min(res.max, used + hitDiceSpent);
      } else if (recovers) {
        // 5e returns half your hit dice on a long rest, not all of them — the fraction is the
        // adapter's to state. Minimum one die back whenever any were spent, so a level-1
        // character is not permanently out of hit dice.
        const restored = Math.max(used > 0 ? 1 : 0, Math.floor(res.max * restModelForAdapter(adapter).longRestHitDiceFraction));
        hitDiceRecovered = Math.min(used, restored);
        used = Math.max(0, used - hitDiceRecovered);
        if (hitDiceRecovered > 0) resourcesRecovered.push(key);
      }
      next.used = used;
      resourcesAfter[key] = next;
      continue;
    }

    if (recovers && res.used > 0) {
      resourcesRecovered.push(key);
      next.used = 0;
    }
    resourcesAfter[key] = next;
  }

  // ── conditions ───────────────────────────────────────────────────────────────────────
  const conditionsCleared: string[] = [];
  const conditionsKept: string[] = [];
  const conditionsDecremented: CharacterRestPlan['conditionsDecremented'] = [];
  const conditionsAfter: RestConditionState[] = [];
  for (const cond of character.conditions) {
    const outcome = restConditionOutcome(cond.name, kind, model, adapter.id);
    if (outcome === 'clear') {
      conditionsCleared.push(cond.name);
      continue;
    }
    if (outcome === 'decrement') {
      // A rest that reduces a leveled condition to 0 stacks removes it entirely (issue #1641)
      // — "exhaustion 1 → long rest → gone", not "exhaustion 1 → long rest → exhaustion 0",
      // since there is no zero-level state for a leveled condition to sit at.
      const stacksAfter = Math.max(0, Math.trunc(cond.stacks) - 1);
      if (stacksAfter <= 0) {
        conditionsCleared.push(cond.name);
      } else {
        conditionsDecremented.push({ name: cond.name, stacksBefore: cond.stacks, stacksAfter });
        conditionsKept.push(cond.name);
        conditionsAfter.push({ name: cond.name, stacks: stacksAfter });
      }
      continue;
    }
    conditionsKept.push(cond.name);
    conditionsAfter.push(cond);
  }

  return {
    plan: {
      characterId: character.id,
      characterName: character.name,
      hpBefore: character.hpCurrent,
      hpAfter,
      hpTempAfter,
      deathStateAfter,
      deathSaveSuccessesAfter,
      deathSaveFailuresAfter,
      spellSlotsAfter,
      resourcesAfter,
      conditionsAfter,
      conditionsCleared,
      conditionsKept,
      conditionsDecremented,
      resourcesRecovered,
      spellSlotLevelsRecovered: levelsRecovered,
      hitDiceSpent,
      hitDiceRolls,
      hitDiceRecovered,
    },
  };
}

/**
 * Plan a rest for a whole party.
 *
 * ATOMICITY IS THE POINT of returning a plan rather than applying as we go: the caller checks
 * `failures` and, if it is non-empty, writes NOTHING. A party rest that healed three characters
 * and then rejected the fourth would leave the table in a state no one asked for and no single
 * undo reverses — which is exactly the "dozens of tool calls with no atomicity" problem this
 * issue exists to remove, reproduced inside the tool meant to fix it.
 */
export function planPartyRest(
  adapter: RestAdapter,
  characters: readonly RestCharacterState[],
  kind: RestKind,
  optionsByCharacter: Readonly<Record<number, RestCharacterOptions>>,
  roll: RestDieRoller,
): RestPlan {
  const plans: CharacterRestPlan[] = [];
  const failures: RestPlanFailure[] = [];
  for (const character of characters) {
    const result = planCharacterRest(adapter, character, kind, optionsByCharacter[character.id] ?? {}, roll);
    if ('failure' in result) failures.push(result.failure);
    else plans.push(result.plan);
  }
  return { kind, ruleSystem: adapter.id, plans, failures };
}

/**
 * Plan a deliberately scoped custom recovery.  This is kept beside the short /
 * long planner so both paths share the resource representation from #422.  A
 * requested key must be present on the sheet and explicitly selected by the
 * caller; unknown keys are ignored rather than becoming a mechanism to create
 * or erase arbitrary sheet data.
 */
export function planPartyCustomRecovery(
  adapter: RestAdapter,
  characters: readonly RestCharacterState[],
  resourceKeys: readonly string[],
): RestPlan {
  const selected = new Set(resourceKeys);
  const plans: CharacterRestPlan[] = [];
  const failures: RestPlanFailure[] = [];
  for (const character of characters) {
    if (character.deathState === 'dead') {
      failures.push({ characterId: character.id, characterName: character.name, error: 'character_dead', detail: `${character.name} is dead and cannot recover.` });
      continue;
    }
    const resourcesAfter: CharacterRestPlan['resourcesAfter'] = {};
    const resourcesRecovered: string[] = [];
    for (const [key, resource] of Object.entries(character.resources)) {
      const next = { ...resource };
      if (selected.has(key) && resource.used > 0) {
        next.used = 0;
        resourcesRecovered.push(key);
      }
      resourcesAfter[key] = next;
    }
    plans.push({
      characterId: character.id, characterName: character.name,
      hpBefore: character.hpCurrent, hpAfter: character.hpCurrent, hpTempAfter: character.hpTemp,
      deathStateAfter: character.deathState, deathSaveSuccessesAfter: character.deathSaveSuccesses,
      deathSaveFailuresAfter: character.deathSaveFailures, spellSlotsAfter: { ...character.spellSlots },
      resourcesAfter, conditionsAfter: [...character.conditions], conditionsCleared: [],
      conditionsKept: character.conditions.map((condition) => condition.name), conditionsDecremented: [], resourcesRecovered, spellSlotLevelsRecovered: [],
      hitDiceSpent: 0, hitDiceRolls: [], hitDiceRecovered: 0,
    });
  }
  return { kind: 'custom', ruleSystem: adapter.id, plans, failures };
}

/**
 * A one-line, name-free summary of a character's rest for the combat log.
 *
 * Name-free by contract: `appendEvent` redacts `actor`/`target` per role and forbids
 * interpolating combatant names into `detail` (issue #869), so the name goes in the `target`
 * field and never in this string.
 */
export function describeRestForLog(plan: CharacterRestPlan, kind: RestKind): string {
  const parts: string[] = [];
  const healed = plan.hpAfter - plan.hpBefore;
  if (healed > 0) parts.push(`recovered ${healed} HP`);
  if (plan.hitDiceSpent > 0) parts.push(`spent ${plan.hitDiceSpent} hit ${plan.hitDiceSpent === 1 ? 'die' : 'dice'}`);
  if (plan.hitDiceRecovered > 0) parts.push(`regained ${plan.hitDiceRecovered} hit dice`);
  if (plan.spellSlotLevelsRecovered.length > 0) parts.push('spell slots restored');
  if (plan.resourcesRecovered.length > 0) parts.push(`${plan.resourcesRecovered.length} resource(s) restored`);
  if (plan.conditionsCleared.length > 0) parts.push(`cleared ${plan.conditionsCleared.join(', ')}`);
  if (plan.conditionsDecremented.length > 0) {
    parts.push(plan.conditionsDecremented.map((d) => `${d.name} reduced to ${d.stacksAfter}`).join(', '));
  }
  const unchangedKept = plan.conditionsKept.filter((name) => !plan.conditionsDecremented.some((d) => d.name === name));
  if (unchangedKept.length > 0) parts.push(`still ${unchangedKept.join(', ')}`);
  const summary = parts.length > 0 ? parts.join('; ') : 'no change';
  return `${kind === 'long' ? 'Long rest' : 'Short rest'}: ${summary}`;
}
