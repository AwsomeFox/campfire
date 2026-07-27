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

// ---------------------------------------------------------------------------
// Rule-system seam (structural — no runtime import of index.ts, so no cycle).
// ---------------------------------------------------------------------------

/** The recharge cadences a resource can declare (mirrors `AdapterResourceDef.recharge`). */
export type RestRechargeCadence = 'short-rest' | 'long-rest' | 'refocus' | 'dawn' | 'turn-start' | 'special';

/** Which rest is being taken. */
export type RestKind = 'short' | 'long';

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

/** The minimal adapter surface this module reads. The real `RuleSystemAdapter` satisfies it. */
export interface RestAdapter {
  readonly id: string;
  /** Ability-score → modifier; used for the CON bonus on a spent hit die. */
  abilityModifier(score: number): number;
  readonly restModel?: RestModel;
  readonly resources?: readonly { key: string; name: string; recharge: RestRechargeCadence; defaultMax?: number }[];
}

/** Resolve an adapter's rest model, falling back to the conservative neutral one. */
export function restModelForAdapter(adapter: Pick<RestAdapter, 'restModel'>): RestModel {
  return adapter.restModel ?? NEUTRAL_REST_MODEL;
}

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

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
  conditions: readonly string[];
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
  conditionsAfter: string[];
  /** Conditions the rest removed, in the casing they were stored in. */
  conditionsCleared: string[];
  /**
   * Conditions the rest deliberately LEFT in place. Surfaced so a DM sees what a night's sleep
   * did not fix rather than having to diff two sheets — the whole point of the allowlist.
   */
  conditionsKept: string[];
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
  kind: RestKind;
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

/**
 * Does a rest of `kind` clear this condition under this adapter?
 *
 * SEAM FOR ISSUE #1047. Today this is a name match against the adapter's allowlist, because a
 * character's conditions are bare strings with no duration or source. When #1047 gives sheet
 * conditions the metadata combatants already have (`ConditionInstance.durationRounds` /
 * `source` / `isConcentration`), THIS function is the single place that has to learn about it —
 * every caller already asks the question in these terms. The allowlist then becomes the
 * fallback for conditions that still carry no instance data, rather than being replaced.
 */
export function isClearedByRest(condition: string, kind: RestKind, model: RestModel): boolean {
  const list = kind === 'long' ? model.clearedByLongRest : model.clearedByShortRest;
  const target = normalizeCondition(condition);
  if (!target) return false;
  return list.some((c) => normalizeCondition(c) === target);
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
  for (const condition of character.conditions) {
    if (isClearedByRest(condition, kind, model)) conditionsCleared.push(condition);
    else conditionsKept.push(condition);
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
      conditionsAfter: conditionsKept,
      conditionsCleared,
      conditionsKept,
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
  if (plan.conditionsKept.length > 0) parts.push(`still ${plan.conditionsKept.join(', ')}`);
  const summary = parts.length > 0 ? parts.join('; ') : 'no change';
  return `${kind === 'long' ? 'Long rest' : 'Short rest'}: ${summary}`;
}
