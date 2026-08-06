/**
 * Statblock reveal helpers (issue #1926).
 *
 * `Combatant.statblockRevealed` is server-persisted and server-enforced (the
 * player-role encounter read genuinely omits `statblock` until it is true —
 * see `redactMonsterHp` in the server). Everything here is purely about the
 * DM's local, client-side "one-tap kill prompt" convenience: a monster/npc
 * dropping to 0 HP surfaces a dismissible nudge on the DM's own row, offering
 * the existing reveal toggle. It never auto-reveals, and dismissing it is a
 * per-combatant, per-session (in-memory) decision — reloading the page resets
 * it, same as every other transient run-session UI state.
 */
import type { Combatant } from '@campfire/schema';

/**
 * True when a monster/npc combatant has just dropped to (or is sitting at) 0 HP,
 * its statblock is not yet revealed, and the DM hasn't already dismissed the
 * prompt for this combatant this session. `hpCurrent` is only meaningful for the
 * DM's own (unredacted) view — a non-DM never renders this prompt at all.
 */
export function shouldShowKillPrompt(
  combatant: Pick<Combatant, 'id' | 'kind' | 'hpCurrent' | 'statblockRevealed'>,
  dismissedIds: ReadonlySet<number>,
): boolean {
  if (combatant.kind !== 'monster' && combatant.kind !== 'npc') return false;
  if (combatant.statblockRevealed) return false;
  if (combatant.hpCurrent === null || combatant.hpCurrent > 0) return false;
  return !dismissedIds.has(combatant.id);
}

/** Record that the kill prompt was resolved (dismissed, or revealed from it) for a combatant this session. */
export function dismissKillPrompt(dismissedIds: ReadonlySet<number>, combatantId: number): Set<number> {
  const next = new Set(dismissedIds);
  next.add(combatantId);
  return next;
}
