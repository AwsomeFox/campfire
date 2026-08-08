/**
 * Facts an action's structured `spec` can state about itself — the design template's
 * "Casting time / Range / Components / Duration" grid, derived from the fields the spec
 * actually carries instead of a fixed 5e vocabulary.
 *
 * Pure and total: every fact is omitted rather than guessed when the spec is silent, so a
 * text-only action (no spec) yields an empty list and the sheet shows its notes alone. Kept
 * out of CharacterPage.tsx so the derivation is unit-testable without a rendered sheet.
 */
import type { ActionSpec } from '@campfire/schema';

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

/** "3 per long-rest", "3"; '' when the action is at-will. */
export function actionUsesText(spec: ActionSpec): string {
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
    { label: 'Casting', value: flags.join(' · ') },
  ];
  return candidates.filter((f) => f.value !== '');
}

/**
 * Player-safe effect lines from the spec's outcome branches — the template's "Effects"
 * list. Only branch prose and applied-condition phrasing, never hidden monster numbers.
 */
export function actionSpecEffects(spec: ActionSpec | undefined | null): string[] {
  if (!spec) return [];
  const out: string[] = [];
  for (const branch of Object.values(spec.outcomes ?? {})) {
    if (!branch) continue;
    if (branch.text) out.push(branch.text);
    for (const effect of branch.effects ?? []) {
      const line = effect.text || effect.condition;
      if (!line) continue;
      const rounds = effect.rounds != null ? ` (${effect.rounds} round${effect.rounds === 1 ? '' : 's'})` : '';
      out.push(`${line}${rounds}${effect.saveEnds ? ', save ends' : ''}`);
    }
  }
  // Branches repeat phrasing (hit and crit often share an effect); show each line once.
  return [...new Set(out)];
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
