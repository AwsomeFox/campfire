import type { EncounterEvent } from '@campfire/schema';

export interface CombatLogAnnouncementCursor {
  seenEventIds: ReadonlySet<number>;
}

export interface CombatLogAnnouncementAdvance {
  cursor: CombatLogAnnouncementCursor;
  appendedEvents: EncounterEvent[];
}

function punctuate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Concise text shared by the visible history and its screen-reader announcement. */
export function formatCombatLogEventSummary(event: EncounterEvent): string {
  const detail = event.detail.trim();

  // Current turn events already contain the acting combatant in their human-readable
  // detail. Prefixing actor/target would turn this into “Mira: Mira's turn”.
  if (event.type === 'turn') return detail || (event.actor ? `${event.actor}'s turn` : 'Turn changed');

  const actor = event.actor?.trim() || null;
  const target = event.target?.trim() || null;
  const participants = actor && target && actor !== target ? `${actor} to ${target}` : target ?? actor;

  if (!participants) return detail || 'Combat log updated';
  return detail ? `${participants}: ${detail}` : participants;
}

/**
 * Explicit actor/target/outcome phrasing keeps a newly appended entry understandable
 * outside the visual log. It only uses the member-visible event payload, which never
 * contains a redacted monster's exact HP total.
 */
export function formatCombatLogAnnouncement(event: EncounterEvent): string {
  const parts: string[] = [];
  if (event.round > 0) parts.push(`Round ${event.round}`);

  const actor = event.actor?.trim() || null;
  const target = event.target?.trim() || null;
  if (actor) parts.push(`Actor: ${actor}`);
  if (target && target !== actor) parts.push(`Target: ${target}`);

  const outcome = event.detail.trim() || formatCombatLogEventSummary(event);
  parts.push(`Outcome: ${outcome}`);
  return punctuate(parts.join('. '));
}

/** One atomic message prevents a reconnect burst from overwriting earlier entries. */
export function formatCombatLogAnnouncementBatch(events: readonly EncounterEvent[]): string {
  if (events.length === 0) return '';
  const messages = events.map(formatCombatLogAnnouncement).join(' ');
  return events.length === 1 ? messages : `${events.length} new combat log events. ${messages}`;
}

/**
 * Advances an ID-based cursor without re-announcing refetched events. A null cursor
 * establishes the initial history baseline, so opening or refreshing a long encounter
 * never reads its entire past aloud.
 */
export function advanceCombatLogAnnouncements(
  events: readonly EncounterEvent[],
  cursor: CombatLogAnnouncementCursor | null,
): CombatLogAnnouncementAdvance {
  const seenEventIds = new Set(cursor?.seenEventIds ?? []);
  const appendedEvents: EncounterEvent[] = [];

  for (const event of events) {
    if (cursor && !seenEventIds.has(event.id)) appendedEvents.push(event);
    seenEventIds.add(event.id);
  }

  return { cursor: { seenEventIds }, appendedEvents };
}
