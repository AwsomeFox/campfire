/**
 * DM run-session header actions allowed per encounter status (issue #420).
 *
 * Mirrors the server lifecycle guards in `EncountersService`:
 *   - end    — only while `running`
 *   - reopen — only while `ended`
 *   - delete — while `preparing` (abandon prep) or `ended` (remove finished fight)
 *   - start / roll-initiative / next-turn — status-specific prep & live controls
 *
 * Kept pure so UI/API matrix coverage can live in a `.unit.spec.ts` without a browser.
 */

export type EncounterLifecycleStatus = 'preparing' | 'running' | 'ended';

/** Destructive / lifecycle controls shown in the DM header. */
export type EncounterLifecycleAction =
  | 'rollInitiative'
  | 'start'
  | 'nextTurn'
  | 'end'
  | 'reopen'
  | 'delete';

export type EncounterLifecycleActions = Readonly<Record<EncounterLifecycleAction, boolean>>;

const MATRIX: Record<EncounterLifecycleStatus, EncounterLifecycleActions> = {
  preparing: {
    rollInitiative: true,
    start: true,
    nextTurn: false,
    end: false,
    reopen: false,
    delete: true,
  },
  running: {
    rollInitiative: true,
    start: false,
    nextTurn: true,
    end: true,
    reopen: false,
    delete: false,
  },
  ended: {
    rollInitiative: false,
    start: false,
    nextTurn: false,
    end: false,
    reopen: true,
    delete: true,
  },
};

/** Explicit server-aligned matrix: which DM header actions to render for `status`. */
export function dmLifecycleActions(status: EncounterLifecycleStatus): EncounterLifecycleActions {
  return MATRIX[status];
}

/** Whether a confirmation dialog for `action` is still valid under `status`. */
export function isLifecycleConfirmValid(
  action: 'end' | 'reopen' | 'delete',
  status: EncounterLifecycleStatus,
): boolean {
  return dmLifecycleActions(status)[action];
}

/**
 * Delete/Cancel confirm copy. Preparing is abandon-prep (no sheet write-back);
 * ended is a permanent remove of a finished fight.
 */
export function deleteConfirmCopy(status: EncounterLifecycleStatus): { title: string; body: string } {
  if (status === 'preparing') {
    return {
      title: 'Cancel this preparation?',
      body: 'Discards this encounter and its combatants. Nothing has been written back to character sheets.',
    };
  }
  return {
    title: 'Delete this encounter?',
    body: 'This cannot be undone.',
  };
}
