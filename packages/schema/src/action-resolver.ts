/**
 * Structured action resolver — data model + pure, system-aware resolution math (issue #414).
 *
 * The pre-#414 {@link CharacterAction} modelled only `name`, `kind`, `toHit`, `damage`, and
 * `notes` — enough to roll an attack and its damage, but nothing that lets an encounter
 * *resolve* an action end-to-end: targets, ranges/areas, save DCs, success/failure/critical
 * consequences, half-damage on a save, damage type + resistance, applied conditions with a
 * duration, action-economy cost, limited uses / recharge / concentration, or healing / temp HP.
 *
 * This module adds an OPTIONAL structured {@link ActionSpec} that hangs off `CharacterAction`
 * (so every existing action still parses — an action with no `spec` behaves exactly as before,
 * and its freeform `notes` are preserved and now rendered), plus the pure functions the server,
 * the MCP tools, and the web Use flow all share to resolve one. Nothing here does I/O or rolls
 * its own dice: dice come from an injected roller (mirroring `rollActionDice` in index.ts) so
 * the math is deterministic and unit-testable, and the rule-system seam is a small structural
 * {@link ResolverAdapter} (satisfied by the real `RuleSystemAdapter`) so 5e attack-vs-AC /
 * save-vs-DC and PF2e degrees of success are honoured without the resolver hardcoding either.
 *
 * Design rules that keep this honest:
 *  - System-aware, never system-assuming. Attack/save classification asks the adapter for
 *    degrees of success when it provides them (PF2e), else uses the d20 hit/miss + nat-20/1
 *    convention (5e). No silent PF2e math on a 5e fight or vice-versa.
 *  - No silent fallback math. {@link isResolvableSpec} reports whether an action carries enough
 *    structure to auto-resolve; when it does not, the caller shows the full inline statblock
 *    (the freeform notes / toHit / damage) rather than inventing numbers.
 *  - Player-safe vs DM-only text is separated at the type level ({@link ResolvedTarget.playerText}
 *    vs {@link ResolvedTarget.dmText}) so the monster-HP redaction (issue #43) is respected.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Rule-system seam (structural — no runtime import of index.ts, so no cycle).
// ---------------------------------------------------------------------------

/** The four PF2e degrees of success, worst to best (mirrors index.ts PF2E_DEGREES). */
export type ResolverDegree = 'criticalFailure' | 'failure' | 'success' | 'criticalSuccess';

/**
 * How a system turns a critical hit into damage (issue #1053). The two rules in the
 * supported systems differ in what gets multiplied, not by how much:
 *  - `double-dice` — roll the damage dice twice, add the flat modifier ONCE (D&D 5e).
 *  - `double-total` — roll damage normally, then double the whole result INCLUDING the
 *    flat modifier (Pathfinder 2e / Starfinder 2e: "double the damage after adding all
 *    modifiers, bonuses, and penalties").
 *
 * `1d8+3` maxed is the whole difference: 8+8+3 = 19 under `double-dice`, (8+3)*2 = 22
 * under `double-total`. Read via {@link criticalDamageRuleForAdapter}, never off the
 * adapter directly, so an adapter that has not declared a rule keeps 5e behaviour rather
 * than crashing or silently halving.
 */
export type CriticalDamageRule = 'double-dice' | 'double-total';

/**
 * The minimal rule-system surface the resolver reads. The real `RuleSystemAdapter`
 * satisfies this structurally (every adapter has `id` + `abilityModifier`; the PF2e/SF2e
 * adapters additionally expose `degreeOfSuccess`). Declared locally so this module has no
 * runtime dependency on index.ts — avoiding an import cycle with `CharacterAction`, which
 * embeds {@link ActionSpec}.
 */
export interface ResolverAdapter {
  readonly id: string;
  abilityModifier(score: number): number;
  /** PF2e/SF2e only — present ⇒ the system reports degrees of success for checks/saves. */
  degreeOfSuccess?(total: number, dc: number, naturalRoll?: number): ResolverDegree;
  /**
   * OPTIONAL — this system's critical-damage rule (issue #1053). Omit it and
   * {@link criticalDamageRuleForAdapter} returns `double-dice`, matching both 5e and the
   * `ruleSystemAdapter` fallback, so an adapter that has never thought about crits behaves
   * exactly as it did before this seam existed.
   */
  readonly criticalDamage?: CriticalDamageRule;
  /**
   * OPTIONAL, OPT-IN — see {@link ResolverMathProfile}. An adapter that does not declare it is
   * treated as NOT implemented by the structured resolver, which is the safe direction.
   */
  readonly resolverMath?: ResolverMathProfile;
  /**
   * OPTIONAL — this system's OWN attack roll and hit/miss/crit classification (issue #1598),
   * the way {@link criticalDamage} owns the crit-damage rule. Omit it and the resolver falls
   * back to {@link defaultAttackRoll} — today's behaviour, byte-identical — so every adapter
   * that has not implemented its own combat maths keeps working exactly as before this hook
   * existed.
   *
   * A FULL hook, not a rule enum, because unlike `criticalDamage` (one of two multipliers) the
   * thing that differs per system here is not a parameter to one comparison — it is the
   * comparison, and for at least one supported system (Open Legend) even the ROLL ITSELF:
   * exploding attribute dice pools, not a d20. An adapter that implements this decides both.
   */
  resolveAttack?(input: AttackRollInput): AttackRollResult;
  /**
   * OPTIONAL — this system's own proficiency/training bonus, added to an attacker's own bonus
   * (for setting their save DC) or a defender's saving-throw total when they ARE proficient
   * (issue #1599), the way {@link resolveAttack} owns the attack roll. Omit it and the resolver
   * falls back to {@link defaultCheckProficiencyBonus} — which is 0, NOT 5e's formula; see that
   * function's own comment for why the safe default here differs from {@link defaultAttackRoll}'s.
   *
   * Deliberately NOT named `proficiencyBonus` to avoid colliding with
   * `Pf2eRuleSystemAdapter.proficiencyBonus`, which additionally takes a proficiency RANK
   * (trained/expert/master/legendary). The resolver only ever knows a boolean "is this
   * character proficient" — from `character.saveProficiencies`, a plain list with no rank — so
   * it can only ever call a ONE-argument hook. PF2e's implementation of THIS hook (see
   * `Pf2eAdapter` in index.ts) answers with `pf2eProficiencyBonus(level, 'trained')`: the
   * correct floor for "marked proficient" given the sheet does not track finer rank — the same
   * degrade `Pf2eAdapter.initiativeModifier` already makes for Perception.
   */
  checkProficiencyBonus?(level: number): number;
}

/**
 * What an adapter's {@link ResolverAdapter.resolveAttack} hook receives (issue #1598). Mirrors
 * exactly what the resolver already has in hand at the point it used to roll a d20 itself:
 * the flat modifier {@link computeAttackModifier} already assembled (ability score/modifier,
 * proficiency, and any system-specific adjustment applied before this point — e.g. the
 * Archmage escalation die), the target's defence value in whatever convention
 * `targetDefenseValue` returned it, and the same injected roller every other resolver
 * calculation uses (`roll('1d20')` for a d20 system; an adapter that needs single dice, like
 * Open Legend's pool, builds them from `roll('1d{sides}')` the same way).
 */
export interface AttackRollInput {
  readonly modifier: number;
  readonly targetAc: number;
  readonly roll: ActionRollFn;
}

/**
 * What an adapter's {@link ResolverAdapter.resolveAttack} hook returns (issue #1598).
 * `naturalRoll` is the primary/anchor die's face for crit/fumble DISPLAY (`d20 14 +5` in the DM
 * detail line) — `null` for a system with no single "natural roll" concept (Open Legend's total
 * is a multi-die exploding sum with no one face to point at).
 */
export interface AttackRollResult {
  readonly total: number;
  readonly naturalRoll: number | null;
  readonly outcome: OutcomeKey;
  /**
   * Optional adapter-owned target text for human-readable attack evidence. The numeric
   * `targetAc` input stays in the system's native convention; this lets an adapter surface the
   * display comparison that matches its maths (for example, an effective ascending threshold for
   * a descending-AC OSR target) without the server learning that system's conversion rules.
   */
  readonly targetLabel?: string;
}

/**
 * The resolver's OWN attack maths (issue #1598) — everything {@link ResolverAdapter.resolveAttack}
 * exists to let a system override. Roll a single d20, add the flat modifier, and classify via
 * {@link classifyAttackOutcome} (which already asks the adapter for degrees of success when it
 * has them, so PF2e/SF2e are unaffected by this seam — they were never the ascending-AC-only
 * problem). This is the exact sequence `resolveOneTarget` ran inline before this issue; moving
 * it here (and calling it explicitly for an adapter with no `resolveAttack`) is what makes 5e
 * behaviour a NAMED default instead of the only path that existed.
 */
export function defaultAttackRoll(adapter: ResolverAdapter, input: AttackRollInput): AttackRollResult {
  const r = input.roll('1d20');
  const naturalRoll = r.rolls[0] ?? r.total;
  const total = naturalRoll + input.modifier;
  const outcome = classifyAttackOutcome(adapter, total, naturalRoll, input.targetAc);
  return { total, naturalRoll, outcome };
}

/**
 * Resolve one attack through whichever maths apply — the adapter's own
 * {@link ResolverAdapter.resolveAttack} when it declares one, else {@link defaultAttackRoll}
 * (issue #1598). The ONE call site `resolveOneTarget` needs; keeping the "ask the adapter, else
 * fall back" branch here rather than inline is what stops a future caller from reinventing the
 * fallback (or forgetting it) the way `resolveOneTarget` itself used to skip the question
 * entirely.
 */
export function resolveAttackForAdapter(adapter: ResolverAdapter, input: AttackRollInput): AttackRollResult {
  return adapter.resolveAttack ? adapter.resolveAttack(input) : defaultAttackRoll(adapter, input);
}

/**
 * The resolver's OWN proficiency/training bonus (issue #1599) — used when an adapter has not
 * declared {@link ResolverAdapter.checkProficiencyBonus}.
 *
 * UNLIKE {@link defaultAttackRoll}, the safe default here is 0, not 5e's level-based formula.
 * "Roll a d20 plus a modifier against a target number" is a reasonable universal guess for an
 * unaudited system's attack — it is only wrong for the handful of systems with a genuinely
 * different roll (OSR's descending AC, Open Legend's dice pool), both fixed by their own
 * `resolveAttack`. 5e's SPECIFIC proficiency curve (`floor((level-1)/4)+2`) is a much narrower,
 * system-specific assumption than that — silently applying it to an unaudited system would
 * OVERSTATE that system's totals (adding a bonus that may not exist there at all) rather than
 * merely picking a plausible-but-wrong comparison. 0 — "add nothing beyond the ability
 * modifier" — is the one answer that is never an overclaim for a system nobody has audited.
 *
 * Because of that, 5e does NOT rely on this default the way it relies on {@link defaultAttackRoll}
 * — it declares {@link ResolverAdapter.checkProficiencyBonus} explicitly (see `Dnd5eAdapter` in
 * index.ts). 5e is the one adapter that opts OUT of its own default here.
 */
export function defaultCheckProficiencyBonus(): number {
  return 0;
}

/**
 * Resolve the check/save proficiency bonus through whichever maths apply — the adapter's own
 * {@link ResolverAdapter.checkProficiencyBonus} when it declares one, else
 * {@link defaultCheckProficiencyBonus} (issue #1599). Mirrors {@link resolveAttackForAdapter}'s
 * shape exactly — one call site, so a future caller cannot reinvent (or forget) the fallback.
 */
export function checkProficiencyBonusForAdapter(adapter: ResolverAdapter, level: number): number {
  return adapter.checkProficiencyBonus ? adapter.checkProficiencyBonus(level) : defaultCheckProficiencyBonus();
}

/**
 * Resolve the critical-damage rule for an adapter, defaulting to 5e's `double-dice`
 * (issue #1053). Always read the rule through this function: it is the single place the
 * default lives, so an adapter that has not declared one is never silently given PF2e math.
 */
export function criticalDamageRuleForAdapter(adapter: Pick<ResolverAdapter, 'criticalDamage'>): CriticalDamageRule {
  return adapter.criticalDamage ?? 'double-dice';
}

/**
 * The one set of mechanics the structured resolver's own maths actually implements
 * (issue #1053 review). Named for what it IS rather than for a system, so declaring it is a
 * factual claim an adapter author can check rather than a badge:
 *
 *  - the attack roll is a single **d20** plus a flat modifier;
 *  - it is compared against **ascending** armour class, meet-or-beat;
 *  - proficiency is 5e's **level-based** bonus (`dnd5eProficiencyBonus`).
 *
 * Every one of those is load-bearing and every one is violated by some supported system:
 * Open Legend rolls exploding **attribute dice pools**, not a d20; the OSR variants on the
 * descending convention compare the other way round (`osrAttackHits`); PF2e/SF2e proficiency is
 * level **plus a rank bonus**, and `ActionResolverService.proficiencyBonus` returns 0 for every
 * non-5e adapter, so a trained PF2e save total is understated and can select the wrong
 * degree-of-success branch. Today exactly one adapter can honestly declare this: 5e.
 *
 * STAYS A COMBINED CLAIM ON PURPOSE (issue #1598). #1598 gave OSR and Open Legend their own
 * {@link ResolverAdapter.resolveAttack}, so the ATTACK half of this profile is now true for
 * them too — but `resolverSpeaksCampaignSystem` gates guidance for BOTH `resolve_action` and
 * `saving_throw` off this ONE flag, and the PROFICIENCY half was still 5e-only. Widening
 * `resolverMath` for OSR/Open Legend then would have told the AI driver their SAVES are safe to
 * resolve server-side, which was false: OSR's saves are target-number checks with no DC at all
 * (a shape `saving_throw` cannot express regardless of proficiency), and Open Legend has no
 * proficiency concept in this slot either. So this profile stayed unchanged by #1598 on
 * purpose, deferred to #1599.
 *
 * #1599 CONCLUSION: still does not widen — and could not, for PF2e/SF2e specifically, without
 * this profile stopping being an honest name. `checkProficiencyBonusForAdapter` now gives
 * PF2e/SF2e a real (non-zero) proficiency bonus instead of silently returning 0, which fixes
 * the understated-total-flips-the-degree-of-success-branch bug this issue was filed about. But
 * two things stop that from being "PF2e now satisfies `d20-ascending-ac-5e-proficiency`":
 *   1. The name is not a euphemism — the third clause is SPECIFICALLY 5e's level-based curve.
 *      PF2e's own proficiency (level + a trained/expert/master/legendary rank bonus) is a
 *      different formula by construction, satisfied through its OWN
 *      {@link ResolverAdapter.checkProficiencyBonus}, never through this 5e-named default.
 *      Declaring `RESOLVER_MATH_D20_5E` for PF2e would be a false claim about WHICH maths ran,
 *      even once the maths itself is close enough to be useful.
 *   2. "Close enough to be useful" is not "correct". `character.saveProficiencies` records only
 *      a boolean (proficient or not) — no rank — so PF2e's hook answers every proficient save
 *      with the TRAINED floor (`pf2eProficiencyBonus(level, 'trained')`), same degrade
 *      `Pf2eAdapter.initiativeModifier` already makes for Perception. That is a real
 *      improvement over 0 for every proficient character, and exact for anyone actually
 *      Trained — but it UNDERSTATES an Expert/Master/Legendary save (rank bonus +4/+6/+8, not
 *      +2), which is exactly the failure mode this flag exists to gate on: an understated total
 *      can still select the wrong degree-of-success branch, just less often (only when the true
 *      rank exceeds Trained) than the old blanket 0. Turning on `commit:true` autonomy for that
 *      residual case would be the same overclaim `resolverMath`'s whole design fights.
 *
 * A THIRD, PF2e-shaped profile value is the honest path to widening this gate for PF2e/SF2e —
 * gated on the character sheet actually tracking per-save proficiency rank, not just a boolean.
 * Not built here: it is a data-model change (a new field, a migration, sheet UI), not the
 * narrow "make proficiency adapter-owned" scope this issue asked for. OSR/Open Legend remain
 * excluded for the original, unchanged reason above.
 */
export type ResolverMathProfile = 'd20-ascending-ac-5e-proficiency';

/** The only {@link ResolverMathProfile} that exists today. */
export const RESOLVER_MATH_D20_5E: ResolverMathProfile = 'd20-ascending-ac-5e-proficiency';

/**
 * Does the structured resolver implement THIS system's attack and save maths (#1053 review)?
 *
 * **Opt-in, and deliberately so.** An earlier revision of this gate was a blocklist of the
 * systems known to break, whose default was "resolver is fine" — so every system nobody had
 * audited yet was wrong until someone noticed, and three review rounds each found one more.
 * The failure mode of getting this wrong is `resolve_action` with `commit:true` writing HP off
 * arithmetic that is not the table's rules, so the default has to be closed: an adapter that
 * has not declared {@link ResolverAdapter.resolverMath} is treated as unsupported, and a newly
 * added system withholds until someone checks it rather than failing open.
 *
 * Note this is a claim about the resolver's **own** maths, not about the whole resolver. The
 * adapter-owned parts (degrees of success, {@link CriticalDamageRule}) are correct for the
 * systems that declare them; it is the d20 roll, the AC comparison and the proficiency bonus
 * that are still 5e-shaped. Fixing those is tracked in #1598 / #1599; this predicate exists to
 * keep callers from claiming universality until they are.
 */
export function resolverImplementsSystemMath(adapter: Pick<ResolverAdapter, 'resolverMath'>): boolean {
  return adapter.resolverMath === RESOLVER_MATH_D20_5E;
}

// ---------------------------------------------------------------------------
// Structured action data model (all optional / defaulted → backward compatible).
// ---------------------------------------------------------------------------

/** How an action is resolved: an attack roll vs AC, a saving throw vs DC, a check vs DC, or nothing mechanical. */
export const ActionMode = z.enum(['attack', 'save', 'check', 'none']);
export type ActionMode = z.infer<typeof ActionMode>;

/** Which side of the table an action may legally target. */
export const ActionTargetAllow = z.enum(['enemy', 'ally', 'any', 'self']);
export type ActionTargetAllow = z.infer<typeof ActionTargetAllow>;

/** The area shape an action covers (empty = a single/■untyped target). */
export const ActionShape = z.enum(['single', 'line', 'cone', 'sphere', 'cube', 'circle', 'emanation', 'wall', '']);
export type ActionShape = z.infer<typeof ActionShape>;

/** The named outcome branches an action can resolve into (attack + save/check degrees). */
export const OutcomeKey = z.enum([
  'hit',
  'miss',
  'crit', // critical hit (attack)
  'critMiss', // critical miss / fumble (attack)
  'success', // target succeeded a save / check
  'failure', // target failed a save / check
  'critSuccess', // PF2e critical success
  'critFailure', // PF2e critical failure
]);
export type OutcomeKey = z.infer<typeof OutcomeKey>;

/** Rule provenance so a card can cite where an action's numbers came from (issue #414 data model). */
export const ActionProvenance = z.object({
  ruleSystem: z.string().max(60).default(''), // e.g. 'dnd5e', 'pf2e'
  source: z.string().max(120).default(''), // book / homebrew label
  ref: z.string().max(120).default(''), // page / entry id
});
export type ActionProvenance = z.infer<typeof ActionProvenance>;

/** Action-economy cost: which adapter slot key is consumed, and how many. */
export const ActionCost = z.object({
  // Adapter action-economy slot key ('action', 'bonus', 'reaction', 'actions', 'movement'…).
  // '' = no economy cost (a free action / passive).
  slot: z.string().max(40).default('action'),
  count: z.number().int().min(0).max(10).default(1),
});
export type ActionCost = z.infer<typeof ActionCost>;

/** Limited uses / recharge / concentration / repeated saves / spell-slot consumption. */
export const ActionUses = z.object({
  // Limited-use pool size; 0 = at-will (no pool).
  max: z.number().int().min(0).max(99).default(0),
  // How the pool refreshes: '', 'short-rest', 'long-rest', 'dawn', 'recharge-5-6', 'recharge-6'…
  recharge: z.string().max(40).default(''),
  // The action requires concentration (5e) — starting it breaks a prior concentration.
  concentration: z.boolean().default(false),
  // A "save ends" effect: the target repeats the save each round (drives ActiveEffect.saveEnds).
  repeatSave: z.boolean().default(false),
  // Consume a spell slot of this level on use (0 = none / cantrip / non-spell).
  spellLevel: z.number().int().min(0).max(9).default(0),
  // The specific limited-use resource pool this action consumes (e.g. "Ki").
  resourceKey: z.string().max(80).default(''),
  // How many uses of the resource this action consumes.
  resourceCost: z.number().int().min(0).max(99).default(0),
});
export type ActionUses = z.infer<typeof ActionUses>;

/** Attack-roll definition (mode='attack'). Either an explicit bonus or ability+proficiency. */
export const AttackSpec = z.object({
  // Explicit signed bonus text ("+5", "7"); when set it wins over ability+proficiency.
  bonus: z.string().max(20).default(''),
  // Governing ability key (STR/DEX/…) used when `bonus` is empty.
  ability: z.string().max(24).default(''),
  // Add the actor's proficiency bonus (5e) / level+rank (PF2e) to the attack.
  proficient: z.boolean().default(true),
  // Compare against this defence key on the target ('ac' by default).
  vs: z.string().max(24).default('ac'),
});
export type AttackSpec = z.infer<typeof AttackSpec>;

/** How a save/check DC is sourced: a fixed number, or the actor's ability + proficiency. */
export const DcSource = z.object({
  kind: z.enum(['fixed', 'ability', 'none']).default('none'),
  // kind='fixed': the literal DC.
  dc: z.number().int().min(1).max(60).default(10),
  // kind='ability': governing ability + whether proficiency is added, plus a flat tweak.
  ability: z.string().max(24).default(''),
  proficient: z.boolean().default(true),
  bonus: z.number().int().min(-20).max(20).default(0),
  // 5e spell save DC base (8) vs a generic check DC — kept explicit so PF2e/other bases differ.
  base: z.number().int().min(0).max(30).default(8),
});
export type DcSource = z.infer<typeof DcSource>;

/** Save/check definition (mode='save' | 'check'): which ability the target rolls, vs what DC. */
export const SaveSpec = z.object({
  // Ability the TARGET rolls (DEX save, WIS save, an Athletics check…).
  ability: z.string().max(24).default(''),
  dc: DcSource.default({}),
});
export type SaveSpec = z.infer<typeof SaveSpec>;

/** Range + area shape. */
export const RangeShape = z.object({
  // Free text so any system's phrasing survives ("melee", "touch", "30 ft", "120 ft").
  range: z.string().max(40).default(''),
  shape: ActionShape.default(''),
  // Area size text ("15 ft cone", "20 ft radius"); empty for a single target.
  size: z.string().max(40).default(''),
});
export type RangeShape = z.infer<typeof RangeShape>;

/** Target legality: how many, and which side of the table. */
export const TargetRule = z.object({
  // Number of discrete targets; 0 = an area (bounded by shape/size, resolved per token).
  count: z.number().int().min(0).max(50).default(1),
  allow: ActionTargetAllow.default('any'),
});
export type TargetRule = z.infer<typeof TargetRule>;

/** One typed damage component. */
export const DamagePart = z.object({
  /**
   * DICE ONLY — "2d6", "1d8". Do NOT fold the modifier in as "2d6+3"; put it in {@link flat}.
   *
   * #1053: this comment previously read `Dice expression ("2d6+3")`, which directly
   * contradicted {@link rollBranchDamage}'s contract (defined later in this file): under 5e's
   * `double-dice` critical rule a crit re-rolls `formula` and adds `flat` ONCE. So an author
   * (or an AI writing an inline spec, following this very example) who put the modifier in the
   * formula got the modifier DOUBLED on every crit, silently and with no error — wrong crit
   * damage produced by following the documentation.
   *
   * The split is load-bearing, not stylistic: it is the only thing that lets the resolver
   * apply a SYSTEM's critical rule rather than one hardcoded rule. `double-dice` needs to know
   * which part is dice; `double-total` needs to know the modifier so it can double that too.
   * Fold them together and neither rule can be expressed correctly.
   */
  formula: z.string().max(60).default(''),
  /**
   * The flat modifier applied alongside {@link formula} (also usable alone for fixed damage).
   * How a critical hit treats it is the system's business — see {@link CriticalDamageRule}.
   *
   * #1053: this was `.min(0)`, which made a NEGATIVE modifier ("1d8-1") unrepresentable and
   * forced every producer to smuggle the penalty back into `formula` — where a 5e crit then
   * doubled it. Negatives are legal here; {@link rollBranchDamage} floors the resulting damage
   * at 0 so a large penalty can never turn damage into healing.
   */
  flat: z.number().int().min(-999).max(999).default(0),
  // Damage type ('fire', 'slashing', …); '' = untyped (never resisted).
  type: z.string().max(24).default(''),
});
export type DamagePart = z.infer<typeof DamagePart>;

/** A condition/effect an outcome applies, with a duration + save-ends flag. */
export const AppliedEffect = z.object({
  condition: z.string().max(40).default(''), // condition name from the adapter vocabulary
  // Duration in rounds; null = indefinite / until removed. `text` is human phrasing.
  rounds: z.number().int().min(0).max(999).nullable().default(null),
  text: z.string().max(120).default(''),
  // The effect ends when the target repeats and succeeds a save (drives ActiveEffect wiring).
  saveEnds: z.boolean().default(false),
  // Ongoing per-turn damage magnitude (persistent damage / ongoing fire); 0 = none.
  ongoingDamage: z.number().int().min(0).max(999).default(0),
});
export type AppliedEffect = z.infer<typeof AppliedEffect>;

/**
 * Everything an outcome branch does to a target.
 *
 * CONVENTION (issues #1053/#1600): attack critical doubling belongs to the resolver, so a
 * hand-authored `crit` branch still describes base damage and lets {@link rollBranchDamage}
 * apply the campaign system's {@link CriticalDamageRule}. Save/check degree branches are
 * different: an explicit `critFailure` branch is a degree-specific consequence as authored and
 * is not automatically multiplied again. PF2e/SF2e basic saves get their double damage only when
 * `critFailure` falls back to the ordinary `failure` branch and `success` is marked
 * `halfDamage`; that shape means the branch is the basic-save full-damage baseline.
 */
export const OutcomeBranch = z.object({
  damage: z.array(DamagePart).max(12).default([]),
  // Save-for-half: this branch applies half of the branch's (or the failure branch's) damage.
  halfDamage: z.boolean().default(false),
  healing: z.string().max(60).default(''), // healing dice/flat ("2d8+3")
  tempHp: z.string().max(60).default(''), // temporary-HP grant ("5", "1d4+1")
  effects: z.array(AppliedEffect).max(12).default([]),
  // Player-safe description of what happens on this branch (no hidden monster numbers).
  text: z.string().max(300).default(''),
});
export type OutcomeBranch = z.infer<typeof OutcomeBranch>;

/**
 * The structured action spec (issue #414). Every field is optional / defaulted, and the
 * whole object hangs off `CharacterAction` as an OPTIONAL `spec`, so a pre-#414 action (no
 * spec) is untouched and its `notes` are preserved. When present, it drives the Use flow.
 */
export const ActionSpec = z.object({
  mode: ActionMode.default('none'),
  attack: AttackSpec.default({}),
  save: SaveSpec.default({}),
  cost: ActionCost.default({}),
  uses: ActionUses.default({}),
  range: RangeShape.default({}),
  targets: TargetRule.default({}),
  // Outcome branches keyed by OutcomeKey; only the relevant branches need be present.
  outcomes: z.record(OutcomeKey, OutcomeBranch).default({}),
  provenance: ActionProvenance.default({}),
});
export type ActionSpec = z.infer<typeof ActionSpec>;

// ---------------------------------------------------------------------------
// Damage-type defences (resistance / vulnerability / immunity) — target-side.
// ---------------------------------------------------------------------------

/**
 * A target's per-damage-type defences. Names are matched case-insensitively against a
 * {@link DamagePart.type}. The server derives these from a monster statblock / character
 * sheet when available; the resolver applies them purely (immunity → 0, resistance → half
 * rounded down, vulnerability → double), so the math is testable in isolation.
 */
export const TargetDefenses = z.object({
  resistances: z.array(z.string().max(24)).default([]),
  vulnerabilities: z.array(z.string().max(24)).default([]),
  immunities: z.array(z.string().max(24)).default([]),
});
export type TargetDefenses = z.infer<typeof TargetDefenses>;

export const EMPTY_DEFENSES: TargetDefenses = { resistances: [], vulnerabilities: [], immunities: [] };

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasMeaningfulQualifier(value: Record<string, unknown>): boolean {
  const identityKeys = new Set(['name', 'key', 'damage_type', 'damageType', 'type']);
  return Object.entries(value).some(([key, item]) => {
    if (identityKeys.has(key) || item === null || item === undefined || item === '' || item === false) return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === 'object') return Object.keys(item as Record<string, unknown>).length > 0;
    return true;
  });
}

/**
 * Read statblock damage defences through the aliases used by importers and hand-entered
 * entries, including Open5e v2's `resistances_and_immunities` object. When a vocabulary
 * is supplied, retain only unconditional canonical types. Structured qualifier/exception
 * metadata and qualified display prose are deliberately excluded until attack source tags
 * are part of direct-damage requests.
 */
export function damageDefensesFromStatblock(data: Record<string, unknown> | null | undefined, vocabulary?: readonly string[]): TargetDefenses {
  const nested = recordValue(data?.resistances_and_immunities) ?? recordValue(data?.resistancesAndImmunities);
  // An adapter may support direct-damage rules before declaring a closed vocabulary.
  // Treat an empty list as best-effort parsing, not as "no type is canonical".
  const canonical = vocabulary && vocabulary.length > 0
    ? vocabulary.map((type) => type.toLowerCase())
    : undefined;
  const normalizeStrings = (raw: string): string[] => {
    return raw.split(';').flatMap((clause) => {
      const parts = clause.split(',').map((item) => item.trim()).filter(Boolean);
      if (!canonical) return parts;
      const normalized = parts.map((entry) => entry.toLowerCase().replace(/^and\s+/, ''));
      return normalized.length > 0 && normalized.every((entry) => canonical.includes(entry)) ? normalized : [];
    });
  };
  const readList = (nestedKey: string, ...keys: string[]): string[] => {
    if (!data) return [];
    const direct = keys.map((key) => data[key]).find((value) => value !== undefined && value !== null);
    const value = direct ?? nested?.[nestedKey];
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const display = nested?.[`${nestedKey}_display`];
    const displayedTypes = canonical && typeof display === 'string' && display.trim()
      ? new Set(normalizeStrings(display))
      : null;
    const entries = values.flatMap((item) => {
      if (typeof item === 'string') {
        const types = normalizeStrings(item);
        return displayedTypes ? types.filter((type) => displayedTypes.has(type)) : types;
      }
      const record = recordValue(item);
      if (!record || hasMeaningfulQualifier(record)) return [];
      const typeRecord = recordValue(record.damage_type) ?? recordValue(record.damageType) ?? recordValue(record.type) ?? record;
      const type = String(typeRecord.key ?? typeRecord.name ?? '').trim();
      if (!type) return [];
      if (!canonical) return [type];
      const normalized = type.toLowerCase();
      return canonical.includes(normalized) && (!displayedTypes || displayedTypes.has(normalized)) ? [normalized] : [];
    });
    return [...new Set(entries)];
  };
  return {
    resistances: readList('damage_resistances', 'damage_resistances', 'damageResistances', 'resistances'),
    vulnerabilities: readList('damage_vulnerabilities', 'damage_vulnerabilities', 'damageVulnerabilities', 'vulnerabilities'),
    immunities: readList('damage_immunities', 'damage_immunities', 'damageImmunities', 'immunities'),
  };
}

// ---------------------------------------------------------------------------
// Resolution result types (shared by API + MCP + web). Player-safe vs DM-only
// text is separated so the monster-HP redaction (issue #43) is preserved.
// ---------------------------------------------------------------------------

/** One resolved damage amount after save-half + resistance were applied. */
export const ResolvedDamage = z.object({
  type: z.string().max(24).default(''),
  amount: z.number().int().min(0),
  // The defence that applied, for a transparent DM-facing breakdown.
  applied: z.enum(['normal', 'resistant', 'vulnerable', 'immune', 'halved']).default('normal'),
});
export type ResolvedDamage = z.infer<typeof ResolvedDamage>;

/** The condition an outcome applies to a target, resolved to a concrete duration. */
export const ResolvedEffect = z.object({
  condition: z.string().max(40),
  rounds: z.number().int().min(0).max(999).nullable().default(null),
  saveEnds: z.boolean().default(false),
  ongoingDamage: z.number().int().min(0).max(999).default(0),
});
export type ResolvedEffect = z.infer<typeof ResolvedEffect>;

/** The fully-resolved consequence for one target — everything the apply step needs. */
export const ResolvedTarget = z.object({
  combatantId: z.number().int(),
  name: z.string(),
  outcome: OutcomeKey,
  // Attack path mechanics (DM-only text carries these; player text does not).
  attackTotal: z.number().int().nullable().default(null),
  naturalRoll: z.number().int().nullable().default(null),
  vsValue: z.number().int().nullable().default(null), // the AC / DC compared against
  escalationDie: z.number().int().min(0).max(6).default(0),
  escalationApplied: z.boolean().default(false),
  escalationPrevented: z.boolean().default(false),
  // Save/check path mechanics.
  saveTotal: z.number().int().nullable().default(null),
  saveDc: z.number().int().nullable().default(null),
  degree: z.enum(['criticalFailure', 'failure', 'success', 'criticalSuccess']).nullable().default(null),
  // Consequences.
  damage: z.array(ResolvedDamage).default([]),
  totalDamage: z.number().int().min(0).default(0),
  healing: z.number().int().min(0).default(0),
  tempHp: z.number().int().min(0).default(0),
  effects: z.array(ResolvedEffect).default([]),
  // Player-safe line (never a monster's exact HP); DM line carries the mechanics.
  playerText: z.string().default(''),
  dmText: z.string().default(''),
});
export type ResolvedTarget = z.infer<typeof ResolvedTarget>;

/**
 * A full resolution — what the resolve step computes and the apply step consumes, so the
 * PREVIEW the table sees is byte-identical to what is committed (issue #414 acceptance:
 * "consequences are readable before commit"). Carries the rolled dice for attestability and
 * the per-target consequences. Costs are computed here and applied atomically on commit.
 */
export const ActionResolution = z.object({
  actorCombatantId: z.number().int(),
  actorName: z.string(),
  actionName: z.string(),
  mode: ActionMode,
  // The attack roll (mode='attack'; a single roll compared against each target's AC — 5e
  // makes one attack per target, but the common case is one target).
  playerSummary: z.string().default(''),
  dmSummary: z.string().default(''),
  targets: z.array(ResolvedTarget).default([]),
  // Resource costs to spend atomically on apply.
  costSlot: z.string().default(''),
  costCount: z.number().int().min(0).default(0),
  usesSpent: z.number().int().min(0).default(0),
  spellLevelSpent: z.number().int().min(0).max(9).default(0),
  startsConcentration: z.boolean().default(false),
});
export type ActionResolution = z.infer<typeof ActionResolution>;

/** The campaign policy governing how a resolution is committed (issue #414 step 6). */
export const ActionApplyPolicy = z.enum(['automatic', 'dm-confirmed', 'player-declares']);
export type ActionApplyPolicy = z.infer<typeof ActionApplyPolicy>;

/**
 * Request to resolve an action (issue #414). The action to use is identified by name/index on
 * the actor's sheet, or supplied inline as an ad-hoc `spec` (a DM/AI resolving a monster or
 * one-off action). `targetIds` are the chosen combatant targets. `commit` requests an atomic
 * apply in the same call when the caller is authorized under the campaign policy; otherwise the
 * call returns a preview the DM/table can read before committing.
 */
export const ActionResolveRequest = z.object({
  actorCombatantId: z.number().int(),
  actionName: z.string().max(120).optional(),
  actionIndex: z.number().int().min(0).max(99).optional(),
  spec: ActionSpec.optional(),
  targetIds: z.array(z.number().int()).max(50).default([]),
  commit: z.boolean().default(false),
});
export type ActionResolveRequest = z.infer<typeof ActionResolveRequest>;

/** A 5e concentration save required by damage that just landed on a concentrating caster. */
export const ConcentrationCheck = z.object({
  damage: z.number().int().positive(),
  dc: z.number().int().min(10),
});
export type ConcentrationCheck = z.infer<typeof ConcentrationCheck>;

/** A durable 5e concentration save request queued on the damaged combatant. */
export const PendingConcentrationCheck = ConcentrationCheck.extend({
  id: z.string().min(1).max(120),
});
export type PendingConcentrationCheck = z.infer<typeof PendingConcentrationCheck>;

/** Bound persisted turn-state growth during an unresolved damage burst. */
export const MAX_PENDING_CONCENTRATION_CHECKS = 20;

/** Per-target snapshot captured before an apply, so an apply is fully reversible (undo). */
export const ActionUndoTarget = z.object({
  combatantId: z.number().int(),
  hpBefore: z.number().int(),
  hpTempBefore: z.number().int(),
  deathStateBefore: z.string(),
  deathSaveSuccessesBefore: z.number().int(),
  deathSaveFailuresBefore: z.number().int(),
  conditionsBefore: z.array(z.string()),
  // Issue #1452: full condition-instances snapshot, stored as JSON so undo can
  // restore structured instances instead of re-deriving them from names.
  conditionInstancesBeforeJson: z.string().optional(),
  // Issue #1452: full turn-state snapshot, stored as JSON for the same reason.
  turnStateBeforeJson: z.string().optional(),
  // Issue #1452: true for combatants added only because a cascade touched them;
  // they must be restored on undo but are not re-checked against the action's target-allow rule.
  isCascadeSnapshot: z.boolean().optional(),
  effectIdsAdded: z.array(z.string()).default([]),
});
export type ActionUndoTarget = z.infer<typeof ActionUndoTarget>;

/**
 * A self-contained reversal payload returned by an apply and passed back to undo (issue #414).
 * It carries each target's pre-apply HP/condition/effect snapshot plus the actor's spent
 * resources, so undo restores the exact prior state atomically without any server-side staging.
 */
export const ActionUndoToken = z.object({
  encounterId: z.number().int(),
  actorCombatantId: z.number().int(),
  actionName: z.string().default(''),
  /** Combat-log chain id for the apply being reversed (issue #426). */
  chainId: z.string().max(64).nullable().default(null),
  targets: z.array(ActionUndoTarget).default([]),
  costSlot: z.string().default(''),
  costCount: z.number().int().min(0).default(0),
  spellLevelSpent: z.number().int().min(0).max(9).default(0),
  concentrationBefore: z.string().nullable().default(null),
  pendingConcentrationChecksBefore: z
    .array(PendingConcentrationCheck)
    .max(MAX_PENDING_CONCENTRATION_CHECKS)
    .default(() => []),
  startedConcentration: z.boolean().default(false),
});
export type ActionUndoToken = z.infer<typeof ActionUndoToken>;

/** One usable action surfaced for a combatant (issue #414): its structure + whether it can auto-resolve. */
export const UsableAction = z.object({
  index: z.number().int().min(0),
  name: z.string(),
  kind: z.string().default(''),
  mode: ActionMode.default('none'),
  // The freeform statblock text (toHit / damage / notes), always preserved + rendered.
  toHit: z.string().default(''),
  damage: z.string().default(''),
  notes: z.string().default(''),
  // True when the structured spec carries enough to run the guided Use flow; false ⇒
  // the caller must fall back to the inline statblock rather than invent numbers.
  resolvable: z.boolean(),
  spec: ActionSpec.nullable().default(null),
});
export type UsableAction = z.infer<typeof UsableAction>;

/** The result of a resolve call — the preview, whether it was applied, and the policy in force. */
export const ActionResolveResult = z.object({
  resolution: ActionResolution,
  applied: z.boolean(),
  canApply: z.boolean(),
  policy: ActionApplyPolicy,
  undoToken: ActionUndoToken.nullable().default(null),
  /**
   * Issue #1451: a lookup key into the EXACT resolution the server just computed and
   * persisted server-side (`action_pending_resolutions`), minted on every resolve regardless
   * of whether this call also committed it. `/actions/apply` takes this alone — never a
   * client-echoed resolution — so the applied numbers can only ever be the server's own roll.
   */
  chainId: z.string().min(1).max(64),
});
export type ActionResolveResult = z.infer<typeof ActionResolveResult>;

/**
 * Request to apply a previously resolved action chain (issue #414 confirm path; issue #1451).
 * `chainId` is a LOOKUP KEY only — the server re-reads its own persisted resolution for that
 * chain (`action_pending_resolutions`, written by `resolve()`) rather than trusting any
 * resolution the caller supplies, so a player can no longer inflate `totalDamage`, per-target
 * deltas, or inject `conditionsAfter`/effect payloads that were never in the resolved spec.
 *
 * DELIBERATELY chainId-only — no caller-supplied display fields (issue #1451 review, second
 * pass). An earlier revision added optional `actionName`/`actorCombatantId` here so a queued
 * `apply_action` DM confirmation could show more than an opaque chain id. That was wrong: the
 * confirmation prompt is what a human DM approves, and `apply()` executes whatever `chainId`
 * identifies regardless of what these fields said — a caller could label a damaging chain as a
 * harmless action by a different actor and obtain approval under a false summary. The
 * confirmation now derives its label SERVER-SIDE from the persisted `action_pending_resolutions`
 * row (see `ActionResolverService.describePendingChain` and its call site in
 * `AiDriverService`), never from anything the request carries.
 */
export const ActionApplyRequest = z.object({
  chainId: z.string().min(1).max(64),
});
export type ActionApplyRequest = z.infer<typeof ActionApplyRequest>;

// ---------------------------------------------------------------------------
// Pure resolver math.
// ---------------------------------------------------------------------------

/** An injected dice roller: given a dice expression, return the total + individual dice. */
export type ActionRollFn = (expr: string) => { total: number; rolls: number[] };

/** Half a damage total, rounded down (5e "half damage on a successful save"). */
export function halveDamage(n: number): number {
  return Math.floor(Math.max(0, n) / 2);
}

/** Parse a signed bonus like "+5", "7", "-1" to a number; NaN-safe (returns 0). */
export function parseSignedBonus(text: string): number {
  const t = (text ?? '').trim();
  if (t === '') return 0;
  const n = Number.parseInt(t.replace(/^\+/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Read an ability score from a stats map tolerantly (uppercase-folded; default 10). */
function readScore(stats: Record<string, number> | null | undefined, ability: string): number {
  if (!stats || !ability) return 10;
  const up = ability.toUpperCase();
  const raw = stats[up] ?? stats[ability] ?? stats[ability.toLowerCase()];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 10;
}

/** One component of a transparent attack/DC breakdown. */
export interface ResolverBreakdown {
  label: string;
  value: number;
}

/**
 * Compute the attack-roll modifier for an action (issue #414). An explicit `attack.bonus`
 * ("+5") wins outright (the number is authoritative — a monster statblock's printed to-hit).
 * Otherwise it is the governing ability modifier (via the adapter) plus, when `proficient`,
 * the supplied proficiency bonus. Returns the total + a breakdown for DM display.
 */
export function computeAttackModifier(
  spec: ActionSpec,
  adapter: ResolverAdapter,
  actorStats: Record<string, number> | null | undefined,
  proficiencyBonus: number,
): { modifier: number; breakdown: ResolverBreakdown[] } {
  const a = spec.attack;
  if (a.bonus.trim() !== '') {
    const v = parseSignedBonus(a.bonus);
    return { modifier: v, breakdown: [{ label: 'attack bonus', value: v }] };
  }
  const breakdown: ResolverBreakdown[] = [];
  let modifier = 0;
  if (a.ability) {
    const mod = adapter.abilityModifier(readScore(actorStats, a.ability));
    modifier += mod;
    breakdown.push({ label: a.ability.toUpperCase(), value: mod });
  }
  if (a.proficient && proficiencyBonus !== 0) {
    modifier += proficiencyBonus;
    breakdown.push({ label: 'proficiency', value: proficiencyBonus });
  }
  return { modifier, breakdown };
}

/**
 * Compute the DC an action's save/check is taken against (issue #414). A `fixed` DC is
 * returned verbatim; an `ability` DC is `base + ability modifier + (proficiency when
 * proficient) + bonus` — the 5e spell-save-DC shape (base 8) generalised so PF2e/other bases
 * differ. `none` yields null (the caller must fall back to a statblock rather than invent one).
 */
export function computeSaveDc(
  source: DcSource,
  adapter: ResolverAdapter,
  actorStats: Record<string, number> | null | undefined,
  proficiencyBonus: number,
): { dc: number | null; breakdown: ResolverBreakdown[] } {
  if (source.kind === 'fixed') {
    return { dc: source.dc, breakdown: [{ label: 'DC', value: source.dc }] };
  }
  if (source.kind === 'ability') {
    const breakdown: ResolverBreakdown[] = [{ label: 'base', value: source.base }];
    let dc = source.base;
    if (source.ability) {
      const mod = adapter.abilityModifier(readScore(actorStats, source.ability));
      dc += mod;
      breakdown.push({ label: source.ability.toUpperCase(), value: mod });
    }
    if (source.proficient && proficiencyBonus !== 0) {
      dc += proficiencyBonus;
      breakdown.push({ label: 'proficiency', value: proficiencyBonus });
    }
    if (source.bonus !== 0) {
      dc += source.bonus;
      breakdown.push({ label: 'bonus', value: source.bonus });
    }
    return { dc, breakdown };
  }
  return { dc: null, breakdown: [] };
}

/**
 * Classify an ATTACK roll into an outcome branch key (issue #414). System-aware:
 *  - When the adapter reports degrees of success (PF2e), the attack is treated as a check
 *    vs AC and mapped: criticalSuccess→crit, success→hit, failure→miss, criticalFailure→critMiss.
 *  - Otherwise (5e / d20): a natural 20 is a crit, a natural 1 is an automatic miss (critMiss),
 *    else total ≥ AC hits.
 *
 * "total ≥ AC" assumes ASCENDING armour class and a d20 roll — true for 5e, PF2e and SF2e, not
 * universal (issue #1053 review found the OSR descending convention and Open Legend's dice pools
 * as counterexamples). This function is no longer the only path to an attack outcome: it is now
 * {@link defaultAttackRoll}'s comparison, used when an adapter has not implemented its OWN
 * {@link ResolverAdapter.resolveAttack} (issue #1598) — OSR and Open Legend both now do, so they
 * never reach this function's AC comparison for an attack. It stays exactly as written because
 * every adapter that HAS NOT implemented `resolveAttack` still wants precisely this — including
 * pathfinder-1e/starfinder-1e/archmage/cepheus, audited for #1598 and confirmed ascending-AC d20
 * systems that this comparison already serves correctly (see the PR for #1598 for that audit).
 * `resolverImplementsSystemMath`/{@link ResolverMathProfile} are a SEPARATE, still-open question
 * about the AI DRIVER's guidance gate, not about which maths this function runs.
 */
export function classifyAttackOutcome(
  adapter: ResolverAdapter,
  total: number,
  naturalRoll: number | null,
  targetAc: number,
): OutcomeKey {
  if (adapter.degreeOfSuccess) {
    const deg = adapter.degreeOfSuccess(total, targetAc, naturalRoll ?? undefined);
    return deg === 'criticalSuccess' ? 'crit' : deg === 'success' ? 'hit' : deg === 'criticalFailure' ? 'critMiss' : 'miss';
  }
  if (naturalRoll === 20) return 'crit';
  if (naturalRoll === 1) return 'critMiss';
  return total >= targetAc ? 'hit' : 'miss';
}

/**
 * Classify a SAVE/CHECK from the TARGET's perspective into an outcome branch key (issue #414).
 * The branch key is the target's degree of success (so a save-for-half spell puts half-damage
 * on the `success` branch and full on `failure`). System-aware:
 *  - PF2e (adapter.degreeOfSuccess): four degrees → critSuccess/success/failure/critFailure.
 *  - 5e / d20: total ≥ DC → success, else failure (no crit on saves).
 */
export function classifySaveOutcome(
  adapter: ResolverAdapter,
  total: number,
  naturalRoll: number | null,
  dc: number,
): { outcome: OutcomeKey; degree: ResolverDegree } {
  if (adapter.degreeOfSuccess) {
    const deg = adapter.degreeOfSuccess(total, dc, naturalRoll ?? undefined);
    const outcome: OutcomeKey =
      deg === 'criticalSuccess' ? 'critSuccess' : deg === 'success' ? 'success' : deg === 'criticalFailure' ? 'critFailure' : 'failure';
    return { outcome, degree: deg };
  }
  const success = total >= dc;
  return { outcome: success ? 'success' : 'failure', degree: success ? 'success' : 'failure' };
}

/**
 * Select the outcome branch for a resolved outcome key, with sensible fallbacks so an action
 * that only defines the common branches still resolves a crit/degree (issue #414):
 *  - crit → hit; critMiss → miss; critSuccess → success; critFailure → failure.
 * Returns null when neither the exact key nor its fallback is defined (caller applies nothing).
 */
export function pickOutcomeBranch(spec: ActionSpec, key: OutcomeKey): OutcomeBranch | null {
  const outcomes = spec.outcomes as Partial<Record<OutcomeKey, OutcomeBranch>>;
  const fallback: Partial<Record<OutcomeKey, OutcomeKey>> = {
    crit: 'hit',
    critMiss: 'miss',
    critSuccess: 'success',
    critFailure: 'failure',
  };
  return outcomes[key] ?? (fallback[key] ? outcomes[fallback[key]!] ?? null : null);
}

/** Whether an outcome key represents a critical hit (doubles damage dice in 5e). */
export function isCriticalHit(key: OutcomeKey): boolean {
  return key === 'crit';
}

/**
 * Apply a target's damage-type defences to a raw amount (issue #414). Order (5e RAW):
 * halving from a successful save is an "other modifier" applied FIRST, then resistance /
 * vulnerability / immunity. Each step rounds down. Immunity always wins (→ 0). Untyped
 * damage ('') is never resisted. Returns the final amount + which defence applied.
 */
export function applyDamageModifiers(
  amount: number,
  damageType: string,
  defenses: TargetDefenses,
  opts: { half?: boolean } = {},
): { final: number; applied: ResolvedDamage['applied'] } {
  let n = Math.max(0, Math.trunc(amount));
  let applied: ResolvedDamage['applied'] = 'normal';
  if (opts.half) {
    n = halveDamage(n);
    applied = 'halved';
  }
  const type = (damageType ?? '').trim().toLowerCase();
  if (type !== '') {
    const has = (list: string[]) => list.some((t) => t.trim().toLowerCase() === type);
    if (has(defenses.immunities)) return { final: 0, applied: 'immune' };
    if (has(defenses.resistances)) {
      n = halveDamage(n);
      applied = 'resistant';
    } else if (has(defenses.vulnerabilities)) {
      n = n * 2;
      applied = 'vulnerable';
    }
  }
  return { final: n, applied };
}

/**
 * Whether an action carries enough structure to auto-resolve (issue #414). Used by the UI /
 * server to decide between the guided Use flow and the "fall back to a full inline statblock,
 * not silent math" acceptance criterion. An attack needs a bonus or an ability; a save/check
 * needs a resolvable DC source. `none` mode never auto-resolves (it's a descriptive action).
 */
export function isResolvableSpec(spec: ActionSpec | null | undefined): boolean {
  if (!spec) return false;
  if (spec.mode === 'attack') {
    return spec.attack.bonus.trim() !== '' || spec.attack.ability.trim() !== '';
  }
  if (spec.mode === 'save' || spec.mode === 'check') {
    return spec.save.dc.kind !== 'none';
  }
  return false;
}

/**
 * Roll a damage branch, applying the campaign system's CRITICAL rule (issues #414, #1053).
 *
 * This used to hardcode 5e — re-roll `formula`, add `flat` once — for every system, so a
 * PF2e `1d8+3` critical resolved as `2d8+3` when PF2e says double the total (`(1d8+3)*2`).
 * The rule now arrives as {@link CriticalDamageRule}, read from the adapter via
 * {@link criticalDamageRuleForAdapter}; it defaults to `double-dice` so a caller that passes
 * nothing (and an adapter that declares nothing) keeps the previous 5e behaviour exactly.
 *
 * Both rules depend on the {@link DamagePart} convention that `formula` is DICE ONLY and
 * `flat` carries the modifier — that split is what makes "which part gets multiplied" a
 * question the data can answer. `flat` may be negative (a damage penalty); the per-part total
 * is floored at 0 so a penalty larger than the roll deals nothing rather than healing the
 * target. Uses the injected roller so the math is deterministic under test.
 */
export function rollBranchDamage(
  branch: OutcomeBranch,
  roll: ActionRollFn,
  opts: { critical?: boolean; criticalRule?: CriticalDamageRule } = {},
): { parts: { type: string; amount: number }[] } {
  const rule = opts.criticalRule ?? 'double-dice';
  const parts: { type: string; amount: number }[] = [];
  for (const part of branch.damage) {
    let dice = 0;
    if (part.formula.trim() !== '') {
      dice += roll(part.formula).total;
      // 5e: the crit buys an extra set of DICE only; the modifier is still added once below.
      if (opts.critical && rule === 'double-dice') dice += roll(part.formula).total;
    }
    let amount = dice + part.flat;
    // PF2e/SF2e: double everything, modifiers and penalties included, AFTER summing.
    if (opts.critical && rule === 'double-total') amount *= 2;
    parts.push({ type: part.type, amount: Math.max(0, amount) });
  }
  return { parts };
}
