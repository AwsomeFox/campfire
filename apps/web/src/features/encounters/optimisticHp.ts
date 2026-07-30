import type { Combatant } from '@campfire/schema';
import {
  applyStarfinderDamage,
  ruleSystemAdapter,
  STARFINDER_ADAPTER_ID,
} from '@campfire/schema';
import { withOptimisticHpLifecycle } from './combatantLifecycle';

/**
 * Applies the client-side HP estimate for one pending mutation.
 */
export function applyOptimisticHpDelta(c: Combatant, delta: number, ruleSystem?: string | null): Combatant {
  if (c.hpCurrent == null || c.hpMax == null) return c;
  const isStarfinder =
    ruleSystemAdapter(ruleSystem).id === STARFINDER_ADAPTER_ID ||
    ruleSystem?.startsWith('starfinder') ||
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
    return hpCurrent > 0 ? withOptimisticHpLifecycle(c, hpCurrent, false) : { ...c, hpCurrent };
  }
  // Damage: temporary HP absorbs first, then real HP, floored at 0.
  const dmg = -delta;
  const temp = c.hpTemp ?? 0;
  const fromTemp = Math.min(temp, dmg);
  const overflow = dmg - fromTemp;
  // Damage fully absorbed by temporary HP does not change real HP or its
  // lifecycle. Preserve any server-owned death state until the response arrives.
  if (overflow === 0) return { ...c, hpTemp: temp - fromTemp };
  return withOptimisticHpLifecycle({ ...c, hpTemp: temp - fromTemp }, Math.max(0, c.hpCurrent - overflow), overflow > 0);
}

export type OptimisticHpDelta = {
  combatantId: number;
  delta: number;
};

/** Rebuilds the optimistic encounter cache from a committed base plus pending writes. */
export function replayOptimisticHpDeltas(
  encounter: Combatant[],
  operations: readonly OptimisticHpDelta[],
  ruleSystem?: string | null,
): Combatant[] {
  return operations.reduce(
    (combatants, { combatantId, delta }) =>
      combatants.map((combatant) =>
        combatant.id === combatantId ? applyOptimisticHpDelta(combatant, delta, ruleSystem) : combatant,
      ),
    encounter,
  );
}
