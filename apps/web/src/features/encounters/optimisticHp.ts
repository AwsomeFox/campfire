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
};

/**
 * The complete set of fields an HP mechanism (the stepper replay, the bulk
 * "Apply to all" write, and the rollback below) is entitled to touch on a
 * combatant. Everything else on a `Combatant` — `turnState`, conditions,
 * name, initiative, roster membership — is owned by some other writer and
 * must survive an HP write untouched.
 */
function withHpOwnedFields(combatant: Combatant, source: Combatant): Combatant {
  return {
    ...combatant,
    hpCurrent: source.hpCurrent,
    hpTemp: source.hpTemp,
    spCurrent: source.spCurrent,
    rpCurrent: source.rpCurrent,
    deathState: source.deathState,
    deathSaveSuccesses: source.deathSaveSuccesses,
    deathSaveFailures: source.deathSaveFailures,
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
      return before ? withHpOwnedFields(combatant, before) : combatant;
    }),
  };
}

/**
 * Merges HP-owned fields (see `withHpOwnedFields`) for `targetIds` from a
 * recomputed combatants array onto the freshest cached encounter, leaving
 * every other field of every combatant — encounter-level fields AND every
 * non-HP per-combatant field alike (`turnState`, conditions, ...) — exactly
 * as `current` already has them. `recomputed` is expected to have been built
 * from a captured, possibly-stale base (see `replayOptimisticHpDeltas`), so
 * only its HP-owned fields for the touched ids are trustworthy; everything
 * else about it is discarded in favor of `current`.
 *
 * Two roster edges: a target id present in the stale base but absent from
 * `current` (removed by another client meanwhile) is never resurrected —
 * this only ever maps over `current.combatants`. A combatant present in
 * `current` but outside `targetIds` (added by another client, or simply not
 * part of this HP operation) is returned completely untouched.
 */
export function mergeOptimisticHpTargets(
  current: EncounterWithCombatants,
  recomputed: Combatant[],
  targetIds: Iterable<number>,
): EncounterWithCombatants {
  const targets = new Set(targetIds);
  if (targets.size === 0) return current;
  const recomputedById = new Map(recomputed.map((combatant) => [combatant.id, combatant]));
  return {
    ...current,
    combatants: current.combatants.map((combatant) => {
      if (!targets.has(combatant.id)) return combatant;
      const source = recomputedById.get(combatant.id);
      return source ? withHpOwnedFields(combatant, source) : combatant;
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
