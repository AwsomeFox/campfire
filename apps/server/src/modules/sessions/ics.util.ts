import type { ScheduledSession } from '@campfire/schema';

/**
 * Minimal RFC 5545 (iCalendar) generation for the campaign schedule feed —
 * hand-rolled on purpose (a dependency for ~40 lines of well-specified text
 * format is not worth it). Covers exactly what calendar clients need from a
 * read-only PUBLISH feed: escaping, UTC date-times, and 75-octet line folding.
 */

/** TEXT value escaping per RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** ISO string -> UTC basic format `YYYYMMDDTHHMMSSZ` (form 2, §3.3.5). */
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Fold content lines longer than 75 octets (§3.1) with CRLF + single space.
 * Splits on characters rather than octets — safe (never exceeds the limit by
 * enough to matter to real parsers) and keeps this dependency-free.
 */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  parts.push(rest);
  return parts.join('\r\n');
}

/**
 * Build the full VCALENDAR document for a campaign's scheduled sessions.
 * All schedules are included (past and future) — calendar clients handle
 * history fine and it keeps previously-synced events from vanishing.
 */
export function buildCampaignIcs(campaign: { id: number; name: string }, schedules: ScheduledSession[]): string {
  const now = toIcsUtc(new Date().toISOString());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Campfire//Session Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`${campaign.name} — Campfire`)}`,
  ];

  for (const s of schedules) {
    const startMs = Date.parse(s.scheduledAt);
    const endIso = new Date(startMs + s.durationMinutes * 60_000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      // Stable per schedule row so clients update-in-place across polls.
      `UID:campfire-c${campaign.id}-s${s.id}@campfire`,
      `DTSTAMP:${now}`,
      `DTSTART:${toIcsUtc(s.scheduledAt)}`,
      `DTEND:${toIcsUtc(endIso)}`,
      `SUMMARY:${icsEscape(s.title || `${campaign.name} — D&D session`)}`,
    );
    if (s.location) lines.push(`LOCATION:${icsEscape(s.location)}`);
    if (s.notes) lines.push(`DESCRIPTION:${icsEscape(s.notes)}`);
    lines.push(`LAST-MODIFIED:${toIcsUtc(s.updatedAt)}`, 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
