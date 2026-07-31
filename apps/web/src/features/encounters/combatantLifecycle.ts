import type { Combatant, HpModel, RuleSystemAdapter } from '@campfire/schema';
import { hpModelForAdapter, ruleSystemAdapter } from '@campfire/schema';

export function resolveHpModel(
  ruleSystemOrAdapterOrHpModel?: string | RuleSystemAdapter | HpModel | null,
): HpModel {
  if (!ruleSystemOrAdapterOrHpModel) {
    return hpModelForAdapter(ruleSystemAdapter(null));
  }
  if (typeof ruleSystemOrAdapterOrHpModel === 'string') {
    return hpModelForAdapter(ruleSystemAdapter(ruleSystemOrAdapterOrHpModel));
  }
  if (
    typeof ruleSystemOrAdapterOrHpModel === 'object' &&
    'massiveDamageInstantDeath' in ruleSystemOrAdapterOrHpModel &&
    'deathSaves' in ruleSystemOrAdapterOrHpModel
  ) {
    return ruleSystemOrAdapterOrHpModel as HpModel;
  }
  if (typeof ruleSystemOrAdapterOrHpModel === 'object' && 'hpModel' in ruleSystemOrAdapterOrHpModel) {
    return hpModelForAdapter(ruleSystemOrAdapterOrHpModel as RuleSystemAdapter);
  }
  return hpModelForAdapter(ruleSystemAdapter(null));
}

/**
 * Apply the small, deterministic part of the server's HP lifecycle rule while
 * an HP mutation is in flight. The returned encounter response remains the
 * authority for every other death-state transition.
 */
export function withOptimisticHpLifecycle(
  combatant: Combatant,
  hpCurrent: number,
  damagedWhileDown = true,
  isInstantDeath = false,
  ruleSystemOrAdapterOrHpModel?: string | RuleSystemAdapter | HpModel | null,
): Combatant {
  if (combatant.kind !== 'character') return { ...combatant, hpCurrent };
  const hpModel = resolveHpModel(ruleSystemOrAdapterOrHpModel);

  if (hpCurrent === 0) {
    if ((isInstantDeath && hpModel.massiveDamageInstantDeath) || combatant.deathState === 'dead') {
      return { ...combatant, hpCurrent, deathState: 'dead' };
    }
    if (!hpModel.deathSaves) {
      const deathState =
        hpModel.dyingAtZeroHp && combatant.deathState === 'none' ? 'dying' : combatant.deathState;
      return { ...combatant, hpCurrent, deathState };
    }
    if (damagedWhileDown && combatant.hpCurrent === 0) {
      const deathSaveFailures = Math.min(3, combatant.deathSaveFailures + 1);
      return {
        ...combatant,
        hpCurrent,
        deathState: deathSaveFailures >= 3 ? 'dead' : 'dying',
        deathSaveSuccesses: combatant.deathState === 'stable' ? 0 : combatant.deathSaveSuccesses,
        deathSaveFailures,
      };
    }
    const deathState = combatant.deathState === 'stable' && !damagedWhileDown
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

/** A newer row after our successful DELETE proves that another client restored it. */
export function hasRestoredTrashedEncounter(
  trashedRevision: string | undefined,
  encounterRevision: string,
): boolean {
  return trashedRevision !== undefined && trashedRevision !== encounterRevision;
}

export const REMOVE_COMBATANT_CONFIRM_BODY =
  'This removes their HP, conditions, initiative, and turn state. You can undo it immediately to restore the combatant.';
