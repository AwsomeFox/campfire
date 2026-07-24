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
  // Dice expression ("2d6+3") the roller understands; empty = no dice (flat via `flat`).
  formula: z.string().max(60).default(''),
  // Flat damage when there's no formula (e.g. a fixed 1 point); added to a rolled formula.
  flat: z.number().int().min(0).max(999).default(0),
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

/** Everything an outcome branch does to a target. */
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

/** Per-target snapshot captured before an apply, so an apply is fully reversible (undo). */
export const ActionUndoTarget = z.object({
  combatantId: z.number().int(),
  hpBefore: z.number().int(),
  hpTempBefore: z.number().int(),
  deathStateBefore: z.string(),
  deathSaveSuccessesBefore: z.number().int(),
  deathSaveFailuresBefore: z.number().int(),
  conditionsBefore: z.array(z.string()),
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
  targets: z.array(ActionUndoTarget).default([]),
  costSlot: z.string().default(''),
  costCount: z.number().int().min(0).default(0),
  spellLevelSpent: z.number().int().min(0).max(9).default(0),
  concentrationBefore: z.string().nullable().default(null),
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
});
export type ActionResolveResult = z.infer<typeof ActionResolveResult>;

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
 * Roll a damage branch, doubling the DICE (never the flat modifier) on a critical hit
 * (5e critical: roll the damage dice twice, add the flat once). By convention a
 * {@link DamagePart.formula} is DICE ONLY ("2d6") and {@link DamagePart.flat} is the flat
 * modifier, so a crit re-rolls the formula and adds it, leaving `flat` applied once. Uses
 * the injected roller so the math is deterministic under test.
 */
export function rollBranchDamage(
  branch: OutcomeBranch,
  roll: ActionRollFn,
  opts: { critical?: boolean } = {},
): { parts: { type: string; amount: number }[] } {
  const parts: { type: string; amount: number }[] = [];
  for (const part of branch.damage) {
    let dice = 0;
    if (part.formula.trim() !== '') {
      dice += roll(part.formula).total;
      if (opts.critical) dice += roll(part.formula).total; // extra set of dice for the crit
    }
    parts.push({ type: part.type, amount: Math.max(0, dice + part.flat) });
  }
  return { parts };
}
