import type { ScheduledSession } from '@campfire/schema';

/**
 * Minimal RFC 5545 (iCalendar) generation for the campaign schedule feed —
 * hand-rolled on purpose (a dependency for ~40 lines of well-specified text
 * format is not worth it). Covers exactly what calendar clients need from a
 * read-only PUBLISH feed: escaping, UTC date-times, and 75-octet line folding.
 */

/** TEXT value escaping per RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** ISO string -> UTC basic format `YYYYMMDDTHHMMSSZ` (form 2, §3.3.5). */
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const CONTENT_LINE_OCTETS = 75;
const CONTINUATION_PREFIX = ' ';
const CONTINUATION_PAYLOAD_OCTETS = CONTENT_LINE_OCTETS - Buffer.byteLength(CONTINUATION_PREFIX, 'utf8');
const GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });

function utf8Octets(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Fold one RFC 5545 content line at 75 UTF-8 octets (§3.1).
 *
 * A continuation line starts with exactly one SPACE, and that octet counts
 * toward its 75-octet limit, leaving 74 octets for content. Prefer Unicode
 * grapheme boundaries so emoji sequences, flags, combining marks, and joined
 * scripts stay intact. A single pathological grapheme can itself exceed the
 * available payload; only then do we fall back to Unicode scalar boundaries.
 * No UTF-16 code-unit slicing is used, so a UTF-8 scalar is never split.
 */
export function foldIcsContentLine(line: string): string {
  if (utf8Octets(line) <= CONTENT_LINE_OCTETS) return line;

  const payloads: string[] = [];
  let payload = '';
  let payloadOctets = 0;

  const payloadLimit = (): number =>
    payloads.length === 0 ? CONTENT_LINE_OCTETS : CONTINUATION_PAYLOAD_OCTETS;

  const flush = (): void => {
    if (payloadOctets === 0) return;
    payloads.push(payload);
    payload = '';
    payloadOctets = 0;
  };

  const appendScalarSafe = (value: string): void => {
    for (const scalar of value) {
      const scalarOctets = utf8Octets(scalar);
      if (payloadOctets > 0 && payloadOctets + scalarOctets > payloadLimit()) flush();
      payload += scalar;
      payloadOctets += scalarOctets;
    }
  };

  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    const segmentOctets = utf8Octets(segment);
    if (payloadOctets + segmentOctets <= payloadLimit()) {
      payload += segment;
      payloadOctets += segmentOctets;
      continue;
    }

    flush();
    if (segmentOctets <= payloadLimit()) {
      payload = segment;
      payloadOctets = segmentOctets;
    } else {
      // A user-perceived grapheme may be arbitrarily long (for example, one
      // base character followed by hundreds of combining marks). RFC line
      // length wins in that rare case; retain scalar safety.
      appendScalarSafe(segment);
    }
  }
  flush();

  return payloads
    .map((part, index) => (index === 0 ? part : CONTINUATION_PREFIX + part))
    .join('\r\n');
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
  return lines.map(foldIcsContentLine).join('\r\n') + '\r\n';
}
