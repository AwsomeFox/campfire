import type { Combatant } from '@campfire/schema';
import {
  applyStarfinderDamage,
  ruleSystemAdapter,
  STARFINDER_ADAPTER_ID,
} from '@campfire/schema';

/**
 * Applies the client-side HP estimate for one pending mutation. A failed mutation
 * later applies its opposing delta without replacing other pending cache changes.
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
    return { ...c, hpCurrent: Math.min(c.hpMax, c.hpCurrent + delta) };
  }
  // Damage: temporary HP absorbs first, then real HP, floored at 0.
  const dmg = -delta;
  const temp = c.hpTemp ?? 0;
  const fromTemp = Math.min(temp, dmg);
  const overflow = dmg - fromTemp;
  return { ...c, hpTemp: temp - fromTemp, hpCurrent: Math.max(0, c.hpCurrent - overflow) };
}

export function rollbackOptimisticHpDelta(c: Combatant, delta: number, ruleSystem?: string | null): Combatant {
  return applyOptimisticHpDelta(c, -delta, ruleSystem);
}
