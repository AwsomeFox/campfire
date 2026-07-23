/**
 * Post-create encounter guidance + accessible naming (issue #431).
 *
 * New encounters auto-add the active party, but the preparing banner used to say
 * "Add the party & monsters below" — implying incomplete/duplicated setup. Copy
 * and the create-form name field live here so unit specs can pin the wording
 * without mounting the pages.
 */

export const ENCOUNTER_NAME_ID = 'encounter-name';
export const ENCOUNTER_NAME_LABEL = 'Encounter name';
/** Visible help under the name field (also wired via aria-describedby). */
export const ENCOUNTER_NAME_HELP = 'Required. A short label the table will recognize — for example, Ambush at the ford.';
export const ENCOUNTER_NAME_PLACEHOLDER = 'Ambush at the ford';

/** Concise preparing → initiative → running → ended checklist for new DMs. */
export const ENCOUNTER_LIFECYCLE_STEPS = [
  { id: 'preparing', label: 'Preparing', detail: 'Roster & map' },
  { id: 'initiative', label: 'Initiative', detail: 'Roll or set order' },
  { id: 'running', label: 'Running', detail: 'Take turns' },
  { id: 'ended', label: 'Ended', detail: 'Write HP back to sheets' },
] as const;

export type PreparingGuidanceInput = {
  /** Character combatants already on the roster (usually the auto-added party). */
  partyCombatantCount: number;
  /** Monster + NPC combatants already on the roster. */
  enemyCombatantCount: number;
  /** Whether a battle map is attached. */
  hasMap: boolean;
  /** Campaign has at least one active character (party exists to auto-add). */
  campaignHasActiveParty: boolean;
  /** Campaign has searchable monster compendium content. */
  campaignHasCompendium: boolean;
};

export type PreparingGuidance = {
  /** One-line lead explaining current setup state. */
  lead: string;
  /** Ordered next-step hints tailored to party/compendium/map state. */
  nextSteps: string[];
};

/**
 * Preparing-banner copy after create. When the active party was auto-added,
 * say so explicitly and point at enemies/reinforcements — never "add the party".
 */
export function preparingGuidance(input: PreparingGuidanceInput): PreparingGuidance {
  const { partyCombatantCount, enemyCombatantCount, hasMap, campaignHasActiveParty, campaignHasCompendium } =
    input;

  let lead: string;
  if (partyCombatantCount > 0) {
    lead = 'Your active party was added automatically; add enemies or reinforcements.';
  } else if (campaignHasActiveParty) {
    lead = 'No party members are in this fight yet — add them below, then enemies.';
  } else {
    lead = 'No active party to auto-add. Add combatants below, then roll initiative and Start.';
  }

  const nextSteps: string[] = [];
  if (enemyCombatantCount === 0) {
    nextSteps.push(
      campaignHasCompendium
        ? 'Add enemies from the Compendium (or Manual / NPC tabs).'
        : 'Add enemies with the Manual or NPC tabs (no compendium monsters loaded yet).',
    );
  } else {
    nextSteps.push('Adjust the roster, then roll initiative.');
  }

  if (!hasMap) {
    nextSteps.push('Optional: attach a battle map before you Start.');
  } else {
    nextSteps.push('Place tokens on the map, then Start when ready.');
  }

  nextSteps.push('Lifecycle: Preparing → Initiative → Running → Ended.');

  return { lead, nextSteps };
}
