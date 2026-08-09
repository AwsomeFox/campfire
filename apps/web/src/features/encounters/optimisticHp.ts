import type { Combatant, EncounterWithCombatants, HpModel, RuleSystemAdapter, CustomMechanicsProfile } from '@campfire/schema';
import {
  applyStarfinderDamage,
  ruleSystemAdapter,
  STARFINDER_ADAPTER_ID,
} from '@campfire/schema';
import { withOptimisticHpLifecycle } from './combatantLifecycle';

/**
 * Applies the client-side HP estimate for one pending mutation.
 */
export function applyOptimisticHpDelta(
  c: Combatant,
  delta: number,
  ruleSystem?: string | RuleSystemAdapter | HpModel | null,
  customMechanicsProfile?: CustomMechanicsProfile | null,
): Combatant {
  if (c.hpCurrent == null || c.hpMax == null) return c;
  const isStarfinder =
    (typeof ruleSystem === 'string' &&
      (ruleSystemAdapter(ruleSystem, customMechanicsProfile).id === STARFINDER_ADAPTER_ID || ruleSystem.startsWith('starfinder'))) ||
    (typeof ruleSystem === 'object' && ruleSystem !== null && 'id' in ruleSystem && ruleSystem.id === STARFINDER_ADAPTER_ID) ||
    (c.spMax != null && c.spMax > 0);
  if (isStarfinder && delta < 0) {
    const sfResult = applyStarfinderDamage(
      {
        hpCurrent: c.hpCurrent,
        hpMax: c.hpMax,
        spCurrent: c.spCurrent ?? 0,
        spMax: c.spMax ?? 0,
        rpCurrent: c.rpCurrent ?? 0,
        rpMax: c.rpMax ?? 0,
        hpTemp: c.hpTemp ?? 0,
        deathState: c.deathState ?? 'none',
      },
      -delta,
    );
    return {
      ...c,
      hpCurrent: sfResult.hpCurrent,
      spCurrent: sfResult.spCurrent,
      rpCurrent: sfResult.rpCurrent,
      hpTemp: sfResult.hpTemp,
      deathState: sfResult.deathState,
    };
  }
  if (delta >= 0) {
    const hpCurrent = Math.min(c.hpMax, c.hpCurrent + delta);
    // A zero or capped heal leaves a downed combatant's server-owned lifecycle
    // state alone. Only a real recovery above 0 clears its death-save slate.
    return hpCurrent > 0 ? withOptimisticHpLifecycle(c, hpCurrent, false, false, ruleSystem, customMechanicsProfile) : { ...c, hpCurrent };
  }
  // Damage: temporary HP absorbs first, then real HP, floored at 0.
  const dmg = -delta;
  const temp = c.hpTemp ?? 0;
  const fromTemp = Math.min(temp, dmg);
  const realDmg = dmg - fromTemp;
  // Damage fully absorbed by temporary HP does not change real HP or its
  // lifecycle. Preserve any server-owned death state until the response arrives.
  if (realDmg === 0) return { ...c, hpTemp: temp - fromTemp };
  const newHpCurrent = Math.max(0, c.hpCurrent - realDmg);
  const excessDamage = realDmg - c.hpCurrent;
  const isInstantDeath = c.hpMax != null && c.hpMax > 0 && newHpCurrent === 0 && excessDamage >= c.hpMax;
  return withOptimisticHpLifecycle(
    { ...c, hpTemp: temp - fromTemp },
    newHpCurrent,
    realDmg > 0,
    isInstantDeath,
    ruleSystem,
    customMechanicsProfile,
  );
}

export type OptimisticHpDelta = {
  combatantId: number;
  delta: number;
  /** True once this client's PATCH response proves the operation committed. */
  reflected?: boolean;
};

function sameOptimisticHpFields(left: Combatant, right: Combatant): boolean {
  return left.hpCurrent === right.hpCurrent
    && left.hpTemp === right.hpTemp
    && left.spCurrent === right.spCurrent
    && left.rpCurrent === right.rpCurrent
    && left.deathState === right.deathState
    && left.deathSaveSuccesses === right.deathSaveSuccesses
    && left.deathSaveFailures === right.deathSaveFailures;
}

function removeOptimisticNumberChange(before: number, optimistic: number, updated: number): number;
function removeOptimisticNumberChange(
  before: number | null,
  optimistic: number | null,
  updated: number | null,
): number | null;
function removeOptimisticNumberChange(
  before: number | null,
  optimistic: number | null,
  updated: number | null,
): number | null {
  if (before == null || optimistic == null || updated == null) {
    return updated === optimistic ? before : updated;
  }
  return updated - (optimistic - before);
}

/**
 * Moves an optimistic HP ledger onto a newer encounter snapshot without
 * double-applying operations that the newer response may already contain. The
 * optimistic field changes are removed from the newer values rather than
 * restoring the old fields wholesale, so concurrent server-side HP changes
 * become part of the new base. All turn-owned fields and unrelated combatants
 * advance to the newer snapshot.
 */
export function rebaseOptimisticHpEncounter(
  base: EncounterWithCombatants,
  updated: EncounterWithCombatants,
  operations: Iterable<OptimisticHpDelta>,
  ruleSystem?: string | RuleSystemAdapter | HpModel | null,
  customMechanicsProfile?: CustomMechanicsProfile | null,
): EncounterWithCombatants {
  const pendingOperations = [...operations];
  const pendingCombatantIds = new Set(pendingOperations.map(({ combatantId }) => combatantId));
  if (pendingCombatantIds.size === 0) return updated;
  const baseCombatants = new Map(base.combatants.map((combatant) => [combatant.id, combatant]));
  const fullyOptimisticCombatants = new Map(
    replayOptimisticHpDeltas(base.combatants, pendingOperations, ruleSystem, customMechanicsProfile)
      .map((combatant) => [combatant.id, combatant]),
  );
  return {
    ...updated,
    combatants: updated.combatants.map((combatant) => {
      if (!pendingCombatantIds.has(combatant.id)) return combatant;
      const previous = baseCombatants.get(combatant.id);
      const fullyOptimistic = fullyOptimisticCombatants.get(combatant.id);
      if (!previous || !fullyOptimistic) return combatant;
      const targetOperations = pendingOperations.filter(({ combatantId }) => combatantId === combatant.id);
      const explicitlyReflected = targetOperations.filter(({ reflected }) => reflected === true);
      // A response equal to the complete optimistic projection also proves that
      // all target operations are reflected, even if their PATCH callbacks have
      // not run yet. Otherwise only committed callbacks are safe to subtract.
      const reflectedOperations = sameOptimisticHpFields(combatant, fullyOptimistic)
        ? targetOperations
        : explicitlyReflected;
      if (reflectedOperations.length === 0) return combatant;
      const optimistic = replayOptimisticHpDeltas(
        [previous],
        reflectedOperations,
        ruleSystem,
        customMechanicsProfile,
      )[0];
      if (!optimistic) return combatant;
      const rebased = {
        ...combatant,
        hpCurrent: removeOptimisticNumberChange(previous.hpCurrent, optimistic.hpCurrent, combatant.hpCurrent),
        hpTemp: removeOptimisticNumberChange(previous.hpTemp, optimistic.hpTemp, combatant.hpTemp),
        spCurrent: removeOptimisticNumberChange(previous.spCurrent, optimistic.spCurrent, combatant.spCurrent),
        rpCurrent: removeOptimisticNumberChange(previous.rpCurrent, optimistic.rpCurrent, combatant.rpCurrent),
        deathState: previous.deathState,
        deathSaveSuccesses: removeOptimisticNumberChange(
          previous.deathSaveSuccesses,
          optimistic.deathSaveSuccesses,
          combatant.deathSaveSuccesses,
        ),
        deathSaveFailures: removeOptimisticNumberChange(
          previous.deathSaveFailures,
          optimistic.deathSaveFailures,
          combatant.deathSaveFailures,
        ),
      };
      const replayedWithPreviousLifecycle = replayOptimisticHpDeltas(
        [rebased],
        reflectedOperations,
        ruleSystem,
        customMechanicsProfile,
      )[0];
      return replayedWithPreviousLifecycle?.deathState === combatant.deathState
        ? rebased
        : { ...rebased, deathState: combatant.deathState };
    }),
  };
}

/** Restores optimistic HP fields without rolling back newer turn-owned state. */
export function rollbackOptimisticHpTargets(
  current: EncounterWithCombatants,
  previous: EncounterWithCombatants,
  targetIds: Iterable<number>,
): EncounterWithCombatants {
  const targets = new Set(targetIds);
  if (targets.size === 0) return current;
  const previousCombatants = new Map(previous.combatants.map((combatant) => [combatant.id, combatant]));
  return {
    ...current,
    combatants: current.combatants.map((combatant) => {
      if (!targets.has(combatant.id)) return combatant;
      const before = previousCombatants.get(combatant.id);
      if (!before) return combatant;
      return {
        ...combatant,
        hpCurrent: before.hpCurrent,
        hpTemp: before.hpTemp,
        spCurrent: before.spCurrent,
        rpCurrent: before.rpCurrent,
        deathState: before.deathState,
        deathSaveSuccesses: before.deathSaveSuccesses,
        deathSaveFailures: before.deathSaveFailures,
      };
    }),
  };
}

/** Rebuilds the optimistic encounter cache from a committed base plus pending writes. */
export function replayOptimisticHpDeltas(
  encounter: Combatant[],
  operations: readonly OptimisticHpDelta[],
  ruleSystem?: string | RuleSystemAdapter | HpModel | null,
  customMechanicsProfile?: CustomMechanicsProfile | null,
): Combatant[] {
  return operations.reduce(
    (combatants, { combatantId, delta }) =>
      combatants.map((combatant) =>
        combatant.id === combatantId ? applyOptimisticHpDelta(combatant, delta, ruleSystem, customMechanicsProfile) : combatant,
      ),
    encounter,
  );
}
