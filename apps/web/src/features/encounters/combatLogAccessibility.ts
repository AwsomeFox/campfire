import type { EncounterEvent } from '@campfire/schema';

export interface CombatLogAnnouncementCursor {
  seenEventIds: Set<number>;
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

  // Turn events keep names on actor/target (issue #869) so redaction cannot be bypassed
  // by prose in detail. Compose the visible line from actor; treat a name-free
  // "Combat started" detail as an opening-turn prefix.
  if (event.type === 'turn') {
    if (event.actor) {
      if (/^combat started$/i.test(detail)) return `Combat started — ${event.actor}'s turn`;
      // Legacy rows may still embed the name in detail — prefer that verbatim only when
      // it already mentions the (possibly redacted) actor, otherwise build from actor.
      if (detail && detail.includes(event.actor)) return detail;
      return `${event.actor}'s turn`;
    }
    return detail || 'Turn changed';
  }

  const actor = event.actor?.trim() || null;
  const target = event.target?.trim() || null;
  const participants = actor && target && actor !== target ? `${actor} to ${target}` : target ?? actor;

  if (!participants) return detail || 'Combat log updated';
  // The persisted damage/heal/condition/death details are verb phrases ("took
  // 7 damage", "gained Prone", …). A target-only event therefore reads most
  // naturally without an inserted colon and preserves the established visible-log
  // wording used by players and existing browser journeys.
  if (target && !actor) return detail ? `${target} ${detail}` : target;
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
  const seenEventIds = cursor?.seenEventIds ?? new Set<number>();
  const appendedEvents: EncounterEvent[] = [];

  for (const event of events) {
    if (cursor && !seenEventIds.has(event.id)) appendedEvents.push(event);
    seenEventIds.add(event.id);
  }

  return { cursor: cursor ?? { seenEventIds }, appendedEvents };
}
