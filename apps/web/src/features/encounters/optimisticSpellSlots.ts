import type { SpellSlotLevel } from '@campfire/schema';

/**
 * Applies a client-side spell-slot spend (+delta) or restore (-delta) estimate for one level
 * (issue #1900), so a pip click flips instantly instead of waiting on the round trip to
 * `POST /characters/:id/spell-slots`. Mirrors the server's own clamp
 * (`applySpellSlotDelta` in `@campfire/schema`) — `used` never leaves `[0, max]` — so the
 * optimistic guess can never show something the confirmed response wouldn't. Returns the
 * SAME map reference unchanged when there is no configured pool at that level (nothing to
 * estimate); the caller is expected to roll back to its own pre-mutation snapshot on error,
 * not to reverse this function.
 */
export function applyOptimisticSpellSlotDelta(
  spellSlots: Record<string, SpellSlotLevel> | null,
  level: number,
  delta: number,
): Record<string, SpellSlotLevel> | null {
  const pool = spellSlots?.[String(level)];
  if (!spellSlots || !pool) return spellSlots;
  const nextUsed = Math.max(0, Math.min(pool.max, pool.used + delta));
  return { ...spellSlots, [String(level)]: { ...pool, used: nextUsed } };
}
