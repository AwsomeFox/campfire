import type { Combatant } from '@campfire/schema';

/**
 * Apply the small, deterministic part of the server's HP lifecycle rule while
 * an HP mutation is in flight. The returned encounter response remains the
 * authority for every other death-state transition.
 */
export function withOptimisticHpLifecycle(combatant: Combatant, hpCurrent: number, damagedWhileDown = true): Combatant {
  if (combatant.kind !== 'character') return { ...combatant, hpCurrent };
  if (hpCurrent === 0) {
    const deathState = combatant.deathState === 'dead' || (combatant.deathState === 'stable' && !damagedWhileDown)
      ? combatant.deathState
      : 'dying';
    return { ...combatant, hpCurrent, deathState };
  }
  if (hpCurrent > 0) {
    return {
      ...combatant,
      hpCurrent,
      deathState: 'none',
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
    };
  }
  return { ...combatant, hpCurrent };
}

/** Characters use death saves; preserve recovery controls for any non-character
 * already persisted as dying/dead by an adapter such as Starfinder. */
export function canStabilizeCombatant(combatant: Combatant): boolean {
  return (
    (combatant.kind === 'character' || combatant.deathState !== 'none') &&
    (combatant.deathState === 'dying' ||
      (combatant.hpCurrent != null && combatant.hpCurrent <= 0))
  );
}

/** A late DELETE response must not install an undo action on a different route. */
export function isCurrentCombatantUndoEncounter(requestEncounterId: number, activeEncounterId: number): boolean {
  return requestEncounterId === activeEncounterId;
}

/** A post-trash read must first observe the deletion before a changed row can prove restoration. */
export function hasRestoredTrashedEncounter(
  trashedRevision: string | undefined,
  deletionObserved: boolean,
  encounterRevision: string,
): boolean {
  return trashedRevision !== undefined && deletionObserved && trashedRevision !== encounterRevision;
}

export const REMOVE_COMBATANT_CONFIRM_BODY =
  'This removes their HP, conditions, initiative, and turn state. You can undo it immediately to restore the combatant.';
