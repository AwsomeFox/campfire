/**
 * Post-create encounter guidance + accessible naming (issue #431).
 *
 * New encounters auto-add the active party, but the preparing banner used to say
 * "Add the party & monsters below" — implying incomplete/duplicated setup. Copy
 * and the create-form name field live here so unit specs can pin the wording
 * without mounting the pages.
 */

/** Stable control id — matches Field `fieldIds('encounter', 'name')` (issue #886). */
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

/** Same four steps with the wording a system that has no initiative roll actually uses. */
const NO_INITIATIVE_ROLL_LIFECYCLE_STEPS = ENCOUNTER_LIFECYCLE_STEPS.map((step) =>
  step.id === 'initiative' ? { ...step, label: 'Turn order', detail: 'Drag the roster into order' } : step,
) as ReadonlyArray<{ id: LifecycleStepId; label: string; detail: string }>;

/**
 * The lifecycle checklist for a campaign whose rule system may or may not roll initiative
 * (issue #2123). The step ids are identical either way — it is the same lifecycle, and
 * `activeLifecycleStepId` still names the middle step 'initiative' — only its user-facing
 * label and detail change, because "Initiative — roll or set order" describes a mechanic
 * Ironsworn: Starforged does not have and points at a control the cockpit no longer renders.
 */
export function encounterLifecycleSteps(
  initiativeRollSupported = true,
): ReadonlyArray<{ id: LifecycleStepId; label: string; detail: string }> {
  return initiativeRollSupported ? ENCOUNTER_LIFECYCLE_STEPS : NO_INITIATIVE_ROLL_LIFECYCLE_STEPS;
}

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
  /**
   * Whether this campaign's rule system rolls initiative at all (issue #2123,
   * `hasInitiativeRollForAdapter`). Optional and defaulting to true, mirroring the adapter
   * capability. When false, "then roll initiative" instructs the DM to press a control the
   * cockpit does not render, for a write the server refuses — so the same steps name what
   * actually establishes turn order on that table: the roster order itself.
   */
  initiativeRollSupported?: boolean;
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
  const {
    partyCombatantCount,
    enemyCombatantCount,
    hasMap,
    campaignHasActiveParty,
    campaignHasCompendium,
    initiativeRollSupported = true,
  } = input;

  let lead: string;
  if (partyCombatantCount > 0) {
    lead = 'Your active party was added automatically; add enemies or reinforcements.';
  } else if (campaignHasActiveParty) {
    lead = 'No party members are in this fight yet — add them below, then enemies.';
  } else {
    lead = initiativeRollSupported
      ? 'No active party to auto-add. Add combatants below, then roll initiative and Start.'
      : 'No active party to auto-add. Add combatants below, put them in turn order, then Start.';
  }

  const nextSteps: string[] = [];
  if (enemyCombatantCount === 0) {
    nextSteps.push(
      campaignHasCompendium
        ? 'Add enemies from the Compendium (or Manual / NPC tabs).'
        : 'Add enemies with the Manual or NPC tabs (no compendium monsters loaded yet).',
    );
  } else {
    nextSteps.push(
      initiativeRollSupported
        ? 'Adjust the roster, then roll initiative.'
        : 'Adjust the roster — this system has no initiative roll, so turn order is the roster order. Drag a combatant to move it.',
    );
  }

  if (!hasMap) {
    nextSteps.push('Optional: attach a battle map before you Start.');
  } else {
    nextSteps.push('Place tokens on the map, then Start when ready.');
  }

  nextSteps.push(
    initiativeRollSupported
      ? 'Lifecycle: Preparing → Initiative → Running → Ended.'
      : 'Lifecycle: Preparing → Turn order → Running → Ended.',
  );

  return { lead, nextSteps };
}

export type PlayerGuidanceInput = {
  status: 'preparing' | 'running' | 'ended' | string;
  currentCombatantName?: string | null;
};

/**
 * Player-facing guidance copy for non-DM viewers or lifecycle states (issue #1470).
 */
export function playerGuidance(input: PlayerGuidanceInput): string {
  const { status, currentCombatantName } = input;
  if (status === 'preparing') {
    return 'Waiting for the DM to start.';
  }
  if (status === 'running') {
    return currentCombatantName
      ? `It's ${currentCombatantName}'s turn.`
      : 'Combat in progress.';
  }
  if (status === 'ended') {
    return 'Combat has ended.';
  }
  return '';
}

export type LifecycleStepId = (typeof ENCOUNTER_LIFECYCLE_STEPS)[number]['id'];

export type RosterStateInput = {
  partyCombatantCount?: number;
  enemyCombatantCount?: number;
  needsInitiativeCount?: number;
};

/**
 * Determines the current active lifecycle step ('preparing' | 'initiative' | 'running' | 'ended')
 * based on encounter status and roster state (issue #1470).
 */
export function activeLifecycleStepId(
  status: 'preparing' | 'running' | 'ended' | string,
  rosterState?: RosterStateInput,
): LifecycleStepId {
  if (status === 'ended') return 'ended';
  if (status === 'running') return 'running';
  if (status === 'preparing') {
    if (rosterState && (rosterState.enemyCombatantCount ?? 0) > 0) {
      return 'initiative';
    }
    return 'preparing';
  }
  return 'preparing';
}

