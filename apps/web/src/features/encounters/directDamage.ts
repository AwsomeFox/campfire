import type { DamageSaveOutcome as SharedDamageSaveOutcome } from '@campfire/schema';

export type DamageSaveOutcome = SharedDamageSaveOutcome;

export type DirectDamageMetadata = {
  damageType?: string;
  saveOutcome?: DamageSaveOutcome;
  isCrit?: boolean;
  damageDice?: number;
};

export type TargetDamageApplication = {
  combatantId: number;
  damage: DirectDamageMetadata;
};

/**
 * Build one direct-damage payload per AoE target. A global save selection is the
 * default, while explicit target outcomes let one effect apply full and half damage
 * in the same operation.
 */
export function buildAoeDamageApplications(
  combatantIds: readonly number[],
  baseDamage: DirectDamageMetadata,
  defaultSaveOutcome: DamageSaveOutcome,
  targetSaveOutcomes: Readonly<Partial<Record<number, DamageSaveOutcome>>>,
): TargetDamageApplication[] {
  return combatantIds.map((combatantId) => {
    const damage = { ...baseDamage };
    const saveOutcome = targetSaveOutcomes[combatantId] ?? defaultSaveOutcome;
    if (saveOutcome === 'half') damage.saveOutcome = 'half';
    else delete damage.saveOutcome;
    return { combatantId, damage };
  });
}
