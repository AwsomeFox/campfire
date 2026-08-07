/**
 * rulesHints.ts — static, adapter-scoped rules hints for new players (issue #1939).
 *
 * A pure lookup, keyed by `RuleSystemAdapter.id` (the stable family id — NOT a rule-pack
 * slug; multiple slugs resolve to the same adapter id) then by term id/name, resolving to
 * an i18n KEY (never raw text) for a one-to-two-sentence mechanical summary. Display only:
 * no rules automation, no homebrew-condition mechanism (that's #1505's extension surface).
 *
 * Adapters with no authored hints — everything but 5e today — return `undefined` for every
 * lookup, and the caller renders no hint affordance at all. This is load-bearing: an OSR or
 * Starforged campaign must never show 5e rules text just because the term id happens to
 * collide (e.g. a homebrew "Restrained" condition on a system with no authored hint for it).
 */
import { DND5E_ADAPTER_ID } from '@campfire/schema';

/** actionId (STANDARD_ACTIONS id in TurnWorkspace.tsx) -> i18n key. */
type StandardActionHintMap = Partial<Record<string, string>>;
/** Condition BASE name (see {@link normalizeConditionBaseName}) -> i18n key. */
type ConditionHintMap = Partial<Record<string, string>>;

/** 5e's 9 standard actions (`STANDARD_ACTIONS` in TurnWorkspace.tsx). */
const STANDARD_ACTION_HINTS: Partial<Record<string, StandardActionHintMap>> = {
  [DND5E_ADAPTER_ID]: {
    attack: 'encounters.rulesHints.dnd5e.actions.attack',
    dash: 'encounters.rulesHints.dnd5e.actions.dash',
    dodge: 'encounters.rulesHints.dnd5e.actions.dodge',
    disengage: 'encounters.rulesHints.dnd5e.actions.disengage',
    help: 'encounters.rulesHints.dnd5e.actions.help',
    hide: 'encounters.rulesHints.dnd5e.actions.hide',
    ready: 'encounters.rulesHints.dnd5e.actions.ready',
    search: 'encounters.rulesHints.dnd5e.actions.search',
    use: 'encounters.rulesHints.dnd5e.actions.use',
  },
};

/** 5e's 15 `CONDITIONS` (`packages/schema/src/index.ts`). */
const CONDITION_HINTS: Partial<Record<string, ConditionHintMap>> = {
  [DND5E_ADAPTER_ID]: {
    Blinded: 'encounters.rulesHints.dnd5e.conditions.blinded',
    Charmed: 'encounters.rulesHints.dnd5e.conditions.charmed',
    Deafened: 'encounters.rulesHints.dnd5e.conditions.deafened',
    Exhaustion: 'encounters.rulesHints.dnd5e.conditions.exhaustion',
    Frightened: 'encounters.rulesHints.dnd5e.conditions.frightened',
    Grappled: 'encounters.rulesHints.dnd5e.conditions.grappled',
    Incapacitated: 'encounters.rulesHints.dnd5e.conditions.incapacitated',
    Invisible: 'encounters.rulesHints.dnd5e.conditions.invisible',
    Paralyzed: 'encounters.rulesHints.dnd5e.conditions.paralyzed',
    Petrified: 'encounters.rulesHints.dnd5e.conditions.petrified',
    Poisoned: 'encounters.rulesHints.dnd5e.conditions.poisoned',
    Prone: 'encounters.rulesHints.dnd5e.conditions.prone',
    Restrained: 'encounters.rulesHints.dnd5e.conditions.restrained',
    Stunned: 'encounters.rulesHints.dnd5e.conditions.stunned',
    Unconscious: 'encounters.rulesHints.dnd5e.conditions.unconscious',
  },
};

/**
 * The i18n key for a standard-action chip's hint, or `undefined` when the resolved adapter
 * has no authored hint for this action (including every non-5e adapter today).
 */
export function standardActionHintKey(
  adapterId: string | null | undefined,
  actionId: string,
): string | undefined {
  if (!adapterId) return undefined;
  return STANDARD_ACTION_HINTS[adapterId]?.[actionId];
}

/**
 * Strips a trailing " <integer>" level suffix — e.g. "Frightened 2" -> "Frightened" — so a
 * leveled instance (free-text shorthand, or a structured `ConditionInstance` with `stacks`)
 * resolves against the same base-name hint as its unleveled form.
 */
function normalizeConditionBaseName(conditionName: string): string {
  return conditionName.trim().replace(/\s+\d+$/, '');
}

/**
 * The i18n key for a condition tag's hint, or `undefined` when the resolved adapter has no
 * authored hint for this condition (including every non-5e adapter today, and any custom /
 * homebrew condition name on 5e itself).
 */
export function conditionHintKey(
  adapterId: string | null | undefined,
  conditionName: string,
): string | undefined {
  if (!adapterId) return undefined;
  const base = normalizeConditionBaseName(conditionName);
  return CONDITION_HINTS[adapterId]?.[base];
}

/**
 * Compendium search link for a hint popover's "Full rule" action (issue #1939 criterion 3),
 * prefilled with the term so the reader lands on (or near) the matching entry.
 */
export function rulesHintCompendiumHref(campaignId: number, termLabel: string): string {
  return `/c/${campaignId}/compendium?q=${encodeURIComponent(termLabel)}`;
}
