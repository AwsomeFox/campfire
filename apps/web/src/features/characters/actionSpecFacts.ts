/**
 * Facts an action's structured `spec` can state about itself — the design template's
 * "Casting time / Range / Components / Duration" grid, derived from the fields the spec
 * actually carries instead of a fixed 5e vocabulary.
 *
 * Pure and total: every fact is omitted rather than guessed when the spec is silent, so a
 * text-only action (no spec) yields an empty list and the sheet shows its notes alone. Kept
 * out of CharacterPage.tsx so the derivation is unit-testable without a rendered sheet.
 */
import { describeActionUses, parseRechargeRange, type ActionSpec, type CriticalDamageRule } from '@campfire/schema';

export type ActionFact = { readonly label: string; readonly value: string };

/**
 * Whether the spec describes a real, resolvable action rather than an empty shell.
 *
 * This matters for the two facts whose schema DEFAULTS are non-empty — cost
 * (`{ slot: 'action', count: 1 }`) and targets (`{ count: 1, allow: 'any' }`). Read
 * literally, those defaults make an all-default spec claim "1 action, 1 target", which is
 * the module's own contract inverted: a fabricated fact, not a stated one. `mode: 'none'`
 * is the tell — `inferActionSpecFromText` only ever emits 'attack' or 'save', so a spec
 * still at 'none' declares no action economy for those defaults to describe.
 */
function statesAnAction(spec: ActionSpec): boolean {
  return spec.mode !== 'none';
}

/** "1 action", "2 bonus"; '' when the spec declares no action-economy cost. */
export function actionCostText(spec: ActionSpec): string {
  const { count, slot } = spec.cost;
  if (!slot || count <= 0) return '';
  // A non-default cost was authored deliberately and reads even on a mode-less spec.
  const authored = slot !== 'action' || count !== 1;
  if (!authored && !statesAnAction(spec)) return '';
  return `${count} ${slot}`;
}

/** "120 ft", "30 ft · cone 15 ft"; '' when the spec declares no range or area. */
export function actionRangeText(spec: ActionSpec): string {
  const { range, shape, size } = spec.range;
  const area = size ? `${shape || 'area'} ${size}` : '';
  if (range && area) return `${range} · ${area}`;
  return range || area;
}

/** "1 target", "2 targets (ally)", "Area"; '' when the spec declares no targeting. */
export function actionTargetText(spec: ActionSpec): string {
  const { count, allow } = spec.targets;
  if (count === 0) return spec.range.size ? 'Area' : '';
  const authored = count !== 1 || allow !== 'any';
  if (!authored && !statesAnAction(spec)) return '';
  const who = allow && allow !== 'any' ? ` (${allow})` : '';
  return `${count} target${count === 1 ? '' : 's'}${who}`;
}

/**
 * The save/check an action forces: "DEX save DC 15", or "DEX save" when the DC is computed
 * from the actor rather than fixed. '' for an action that forces neither.
 */
export function actionSaveText(spec: ActionSpec): string {
  if (spec.mode !== 'save' && spec.mode !== 'check') return '';
  const ability = spec.save.ability.toUpperCase();
  const noun = spec.mode === 'save' ? 'save' : 'check';
  const head = ability ? `${ability} ${noun}` : noun.charAt(0).toUpperCase() + noun.slice(1);
  return spec.save.dc.kind === 'fixed' ? `${head} DC ${spec.save.dc.dc}` : head;
}

/**
 * "Recharge 5–6", "3 per long-rest", "3"; '' only when the action really is at-will.
 *
 * A DIE-ROLL recharge is a pool even at the schema's default `max: 0` — see
 * `effectiveActionUsesMax`, which reads that shape as one use held until it recharges — so
 * the schema's own `describeActionUses` owns that label rather than a formula here
 * re-deriving it and (previously) hiding a limited action as at-will entirely.
 *
 * A REST cadence is deliberately not delegated: `describeActionUses` renders every
 * non-die-roll pool as "N/Day", which would relabel a short-rest ability as daily. Those
 * keep the cadence they were authored with. `parseRechargeRange` is the same predicate the
 * schema splits on, so the two branches cannot disagree about which case is which.
 */
export function actionUsesText(spec: ActionSpec): string {
  if (parseRechargeRange(spec.uses.recharge)) return describeActionUses(spec.uses);
  const { max, recharge } = spec.uses;
  if (max <= 0) return '';
  return recharge ? `${max} per ${recharge}` : `${max}`;
}

/** "Level 3 slot", "Concentration"; the extra flags 5e-style specs set. */
function actionFlagTexts(spec: ActionSpec): string[] {
  const out: string[] = [];
  if (spec.uses.spellLevel > 0) out.push(`Level ${spec.uses.spellLevel} slot`);
  if (spec.uses.concentration) out.push('Concentration');
  return out;
}

/**
 * "2 Ki", "Ki"; '' when the action consumes no named resource.
 *
 * A resource cost is independent of the action's OWN limited-use pool: an at-will action
 * can still spend from a shared pool, so reading only `max`/`recharge` made such an action
 * look free. The amount is only stated when the spec gives one.
 */
export function actionResourceText(spec: ActionSpec): string {
  const key = spec.uses.resourceKey.trim();
  if (!key) return '';
  return spec.uses.resourceCost > 0 ? `${spec.uses.resourceCost} ${key}` : key;
}

/** The ordered, non-empty facts for an action's spec (empty when it states nothing). */
export function actionSpecFacts(spec: ActionSpec | undefined | null): ActionFact[] {
  if (!spec) return [];
  const flags = actionFlagTexts(spec);
  const candidates: ActionFact[] = [
    { label: 'Cost', value: actionCostText(spec) },
    { label: 'Range', value: actionRangeText(spec) },
    { label: 'Targets', value: actionTargetText(spec) },
    { label: 'Save', value: actionSaveText(spec) },
    { label: 'Uses', value: actionUsesText(spec) },
    { label: 'Resource', value: actionResourceText(spec) },
    { label: 'Casting', value: flags.join(' · ') },
  ];
  return candidates.filter((f) => f.value !== '');
}

/** One outcome branch's player-safe consequences, under the branch's own name. */
export type ActionEffectGroup = { readonly outcome: string; readonly label: string; readonly lines: readonly string[] };

/**
 * Display order and naming for the outcome branches. Attack branches first, then save /
 * check degrees best-to-worst, so a reader meets consequences in the order the table
 * resolves them.
 */
const OUTCOME_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['crit', 'On a critical hit'],
  ['hit', 'On a hit'],
  ['miss', 'On a miss'],
  ['critMiss', 'On a critical miss'],
  ['critSuccess', 'On a critical success'],
  ['success', 'On a success'],
  ['failure', 'On a failure'],
  ['critFailure', 'On a critical failure'],
];

/**
 * One typed damage component as text: "2d6 fire", "1d8+3 slashing", "5 fire".
 *
 * `DamagePart` keeps dice in `formula` and the modifier in `flat` (that split is what lets
 * a system apply its own critical rule), so both halves are recombined here for display.
 */
function damagePartText(part: { formula: string; flat: number; type: string }): string {
  const dice = part.formula.trim();
  const flat = part.flat;
  const amount = dice
    ? `${dice}${flat > 0 ? `+${flat}` : flat < 0 ? `${flat}` : ''}`
    : flat !== 0
      ? String(flat)
      : '';
  if (!amount) return '';
  return part.type ? `${amount} ${part.type}` : amount;
}

/**
 * Player-safe consequence lines for one outcome branch, in reading order: the authored
 * prose first, then what the branch mechanically does, then the conditions it applies.
 *
 * Every consequence field `OutcomeBranch` defines is covered, not just `text`. A branch can
 * express itself purely mechanically — healing, temp HP, damage, save-for-half — and
 * healing and temp HP have no top-level `CharacterAction` field to fall back on, so reading
 * only `text` made a healing action's entire result invisible on the sheet.
 */
/**
 * How this system's critical rule changes a `crit` branch's printed damage.
 *
 * By schema convention a hand-authored `crit` branch carries BASE damage and
 * `rollBranchDamage` applies the campaign's {@link CriticalDamageRule} on top — 5e's
 * `double-dice` resolves `1d8+3` as `2d8+3`. Printing the branch verbatim therefore
 * understated every critical. The rule is NAMED rather than recomputed into an expression:
 * doubling the dice correctly is the resolver's job, and a second implementation here is
 * exactly the drift that would disagree with it.
 *
 * Only the attack `crit` branch is affected; PF2e-style `critSuccess`/`critFailure` degrees
 * are consequences as authored and are not multiplied again (see `OutcomeBranch`).
 */
function criticalDamageNote(rule: CriticalDamageRule | undefined): string {
  if (rule === 'double-dice') return ', dice doubled on a critical';
  if (rule === 'double-total') return ', total doubled on a critical';
  return '';
}

function branchLines(branch: {
  text: string;
  damage: ReadonlyArray<{ formula: string; flat: number; type: string }>;
  halfDamage: boolean;
  healing: string;
  tempHp: string;
  effects: ReadonlyArray<{ text: string; condition: string; rounds: number | null; saveEnds: boolean; ongoingDamage: number }>;
}, criticalNote = '', fallbackHasDamage = false): string[] {
  const lines: string[] = [];
  if (branch.text) lines.push(branch.text);

  const damage = (branch.damage ?? []).map(damagePartText).filter(Boolean);
  // `halfDamage` is branch-neutral: a schema-valid `miss`, `failure` or `critFailure` may
  // carry it too, and each line already sits under a heading naming its own outcome. Saying
  // "on a success" here put that phrase under "On a failure" and misstated the rule. When
  // the branch has damage of its own the halving qualifies THAT amount, so it reads as one
  // line rather than two that look additive.
  if (damage.length > 0) lines.push(`${damage.join(' + ')} damage${branch.halfDamage ? ' (halved)' : ''}${criticalNote}`);
  // A branch that halves with no damage of its own halves the FAILURE branch's. If that
  // branch has none either, the resolver rolls nothing at all — so saying "Half damage"
  // would promise a consequence using the action never applies.
  else if (branch.halfDamage && fallbackHasDamage) lines.push('Half damage');
  if (branch.healing.trim()) lines.push(`Heals ${branch.healing.trim()}`);
  if (branch.tempHp.trim()) lines.push(`${branch.tempHp.trim()} temporary hit points`);

  for (const effect of branch.effects ?? []) {
    // `text` and `condition` are INDEPENDENT: the resolver applies the condition whether or
    // not prose was written, so "Knocked off balance" must not swallow the fact that the
    // target is Prone. Prose leads; the vocabulary name follows it when it adds anything.
    const prose = effect.text.trim();
    const condition = effect.condition.trim();
    const name = prose && condition && prose.toLowerCase() !== condition.toLowerCase()
      ? `${prose} (${condition})`
      : prose || condition;
    const rounds = effect.rounds != null ? ` (${effect.rounds} round${effect.rounds === 1 ? '' : 's'})` : '';
    const ends = effect.saveEnds ? ', save ends' : '';
    const ongoing = effect.ongoingDamage > 0 ? `${effect.ongoingDamage} ongoing damage` : '';
    // No condition means the RESOLVER drops this effect outright
    // (`ActionResolverService.resolveOneTarget`: `if (!eff.condition) continue`), so a
    // standalone `ongoingDamage` never actually lands. Describing it here would promise
    // recurring damage that using the action does not apply — better silent than untrue.
    if (!condition) continue;
    if (name) lines.push(`${name}${rounds}${ends}${ongoing ? ` · ${ongoing}` : ''}`);
  }
  return lines;
}

/**
 * Whether a damage part can actually produce damage when the resolver rolls it.
 *
 * Not `damage.length` — every `DamagePart` field is optional and defaults (`formula: ''`,
 * `flat: 0`), so a schema-valid `damage: [{}]` is a non-empty array that `rollBranchDamage`
 * resolves to zero (#2115 review). Not `damagePartText` either: that renders a `flat: -3`
 * part as text, while the resolver clamps it with `Math.max(0, amount)`. This is the
 * resolver's own question — is there a formula to roll, or a positive flat amount to add —
 * so "Half damage" is promised only where halving has something to halve.
 */
function partCanDealDamage(part: { formula: string; flat: number }): boolean {
  return part.formula.trim() !== '' || part.flat > 0;
}

/**
 * Player-safe effect lines from the spec's outcome branches — the template's "Effects"
 * list. Branch prose, mechanical consequences, and applied conditions; never hidden
 * monster numbers.
 *
 * Grouped BY BRANCH rather than flattened: a save's `success` and `failure` consequences
 * are mutually exclusive, and one unlabelled list reads as though both apply. Lines are
 * deduplicated within a branch, never across — "Prone" under both `hit` and `crit` is two
 * true statements about two different outcomes, and collapsing them would drop the only
 * thing that says which is which.
 */
export function actionSpecEffects(
  spec: ActionSpec | undefined | null,
  /** The campaign's critical rule, so a `crit` branch's base damage is not understated. */
  criticalDamage?: CriticalDamageRule,
): ActionEffectGroup[] {
  if (!spec) return [];
  const outcomes = spec.outcomes ?? {};
  // What a save-for-half branch would actually halve — see `branchLines`.
  const fallbackHasDamage = (outcomes.failure?.damage ?? []).some(partCanDealDamage);
  const groups: ActionEffectGroup[] = [];
  for (const [outcome, label] of OUTCOME_LABELS) {
    const branch = (outcomes as Record<string, (typeof outcomes)[keyof typeof outcomes]>)[outcome];
    if (!branch) continue;
    const unique = [
      ...new Set(
        branchLines(branch, outcome === 'crit' ? criticalDamageNote(criticalDamage) : '', fallbackHasDamage),
      ),
    ];
    if (unique.length > 0) groups.push({ outcome, label, lines: unique });
  }
  return groups;
}

/**
 * The action's citation ("SRD 5.1 — Evocation"), or '' when unknown.
 *
 * `sheet-inferred` is deliberately excluded: `inferActionSpecFromText` stamps it on a spec
 * it derived from the sheet's own to-hit/damage text, so citing it would claim a source the
 * action does not have.
 */
export function actionSourceText(spec: ActionSpec | undefined | null): string {
  const source = spec?.provenance.source ?? '';
  if (!source || source === 'sheet-inferred') return '';
  const ref = spec?.provenance.ref ?? '';
  return ref ? `${source} — ${ref}` : source;
}
