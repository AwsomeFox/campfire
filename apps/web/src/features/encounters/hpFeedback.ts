import type { Combatant } from '@campfire/schema';

export type HpFeedbackKind = 'damage' | 'heal' | 'tempHp' | 'down' | 'revive' | 'bandTick';

export type HpFeedbackEvent = {
  combatantId: number;
  kind: HpFeedbackKind;
  /** Exact amounts are deliberately absent for server-redacted combatants. */
  amount?: number;
  crit?: boolean;
  /** A band tick never carries numbers; its direction selects localized copy. */
  bandDirection?: 'hurt' | 'recover';
};

export type HpFeedbackSnapshot = Pick<
  Combatant,
  'id' | 'hpCurrent' | 'hpTemp' | 'spCurrent' | 'hpBand' | 'deathState'
>;

function isDown(combatant: HpFeedbackSnapshot): boolean {
  return combatant.deathState === 'dying' || combatant.deathState === 'dead'
    || (combatant.hpCurrent != null ? combatant.hpCurrent <= 0 : combatant.hpBand === 'down');
}

const HP_BAND_SEVERITY = {
  healthy: 0,
  bloodied: 1,
  critical: 2,
  down: 3,
} as const;

/**
 * Compare the server-shaped combatant state at two points in time.
 *
 * Callers seed the first snapshot instead of diffing it. This module also treats a
 * null HP value as a redaction boundary: it only observes a changed band, never
 * attempts to infer an amount from it.
 */
export function diffHpFeedback(
  previous: ReadonlyMap<number, HpFeedbackSnapshot>,
  next: readonly HpFeedbackSnapshot[],
  critCombatantIds: ReadonlySet<number> = new Set(),
): HpFeedbackEvent[] {
  const events: HpFeedbackEvent[] = [];

  for (const combatant of next) {
    const before = previous.get(combatant.id);
    if (!before) continue;

    const wasDown = isDown(before);
    const nowDown = isDown(combatant);
    if (!wasDown && nowDown) {
      events.push({ combatantId: combatant.id, kind: 'down' });
    } else if (wasDown && !nowDown) {
      events.push({ combatantId: combatant.id, kind: 'revive' });
    }

    if (before.hpCurrent == null || combatant.hpCurrent == null) {
      if (
        before.hpBand !== combatant.hpBand
        && before.hpBand != null
        && combatant.hpBand != null
        && !nowDown
        && !wasDown
      ) {
        events.push({
          combatantId: combatant.id,
          kind: 'bandTick',
          bandDirection:
            HP_BAND_SEVERITY[combatant.hpBand] > HP_BAND_SEVERITY[before.hpBand]
              ? 'hurt'
              : 'recover',
        });
      }
      continue;
    }

    const hpDelta = combatant.hpCurrent - before.hpCurrent;
    const tempDelta = (combatant.hpTemp ?? 0) - (before.hpTemp ?? 0);
    const staminaDelta = (combatant.spCurrent ?? 0) - (before.spCurrent ?? 0);
    // Temporary HP contributes to a hit that reached real HP or stamina. A pure
    // shield decrease can be bookkeeping/expiry, so it is intentionally silent.
    if (hpDelta > 0 || staminaDelta > 0) {
      // A real-HP gain is unambiguously a heal even if a temporary pool expired
      // in the same canonical update; stamina recovery is equally a heal for feedback.
      const recovery = (hpDelta > 0 ? hpDelta : 0) + (staminaDelta > 0 ? staminaDelta : 0);
      events.push({ combatantId: combatant.id, kind: 'heal', amount: recovery });
    }
    const hpOrStaminaDamage = (hpDelta < 0 ? -hpDelta : 0) + (staminaDelta < 0 ? -staminaDelta : 0);
    const damage = hpOrStaminaDamage + (hpOrStaminaDamage > 0 && tempDelta < 0 ? -tempDelta : 0);
    if (damage > 0) {
      events.push({
        combatantId: combatant.id,
        kind: 'damage',
        amount: damage,
        crit: critCombatantIds.has(combatant.id),
      });
    }
    if (tempDelta > 0) {
      events.push({ combatantId: combatant.id, kind: 'tempHp', amount: tempDelta });
    }
  }

  return events;
}

export function hpFeedbackSnapshot(combatants: readonly HpFeedbackSnapshot[]): Map<number, HpFeedbackSnapshot> {
  return new Map(combatants.map((combatant) => [combatant.id, combatant]));
}

/** Whether a later response still begins at the state this client observed. */
export function sameHpFeedbackSnapshot(
  left: HpFeedbackSnapshot,
  right: HpFeedbackSnapshot,
): boolean {
  return left.hpCurrent === right.hpCurrent
    && left.hpTemp === right.hpTemp
    && left.spCurrent === right.spCurrent
    && left.hpBand === right.hpBand
    && left.deathState === right.deathState;
}

/**
 * Preserve local optimistic targets while retaining canonical values for everybody
 * else. This keeps an intermediate refetch from inventing an inverse local delta
 * without swallowing a concurrent remote update to another combatant.
 */
export function withOptimisticHpFeedbackTargets(
  canonical: readonly HpFeedbackSnapshot[],
  optimistic: readonly HpFeedbackSnapshot[],
  targetIds: ReadonlySet<number>,
): Map<number, HpFeedbackSnapshot> {
  const snapshot = hpFeedbackSnapshot(canonical);
  for (const combatant of optimistic) {
    if (targetIds.has(combatant.id)) snapshot.set(combatant.id, combatant);
  }
  return snapshot;
}
