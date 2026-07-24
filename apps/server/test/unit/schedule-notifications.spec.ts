/**
 * Schedule notification metadata + locale-aware copy (issue #820).
 *
 * Covers positive/negative UTC offsets, DST boundaries, cross-timezone tables,
 * midnight events, venue/VTT-link/notes change detection, and cancellation copy
 * without leaking private note/venue values into summaries.
 */
import {
  diffScheduleNotificationFields,
  formatScheduleNotificationBody,
  formatScheduleNotificationInstant,
  formatScheduleNotificationTitle,
  parseScheduleNotificationData,
  scheduleNotificationChangeType,
  scheduleNotificationFallbackBody,
  scheduleNotificationFallbackTitle,
  shouldNotifyScheduleUpdate,
  summarizeScheduleChangedFields,
  type ScheduleNotificationData,
} from '@campfire/schema';

const base = {
  scheduledAt: '2026-07-22T00:00:00.000Z', // 8 PM Eastern on Jul 21
  durationMinutes: 240,
  location: "Sam's place",
  notes: 'bring snacks',
};

function data(
  patch: Partial<ScheduleNotificationData> & Pick<ScheduleNotificationData, 'changeType'>,
): ScheduleNotificationData {
  return {
    kind: 'schedule',
    scheduleId: 11,
    scheduledAt: base.scheduledAt,
    durationMinutes: 240,
    changedFields: [],
    label: 'Game night',
    ...patch,
  };
}

describe('schedule notification helpers (issue #820)', () => {
  it('does not bake the UTC calendar day into fallback titles', () => {
    const created = data({ changeType: 'created' });
    expect(scheduleNotificationFallbackTitle(created)).toBe('Game night was scheduled');
    expect(scheduleNotificationFallbackTitle(created)).not.toMatch(/2026-07-22/);
    expect(scheduleNotificationFallbackTitle(data({ changeType: 'cancelled' }))).toBe(
      'Game night was cancelled',
    );
  });

  it('localizes an Eastern evening game as the local day, not the next UTC date', () => {
    // 2026-07-22T00:00:00Z == 2026-07-21 8:00 PM EDT
    const instant = formatScheduleNotificationInstant(base.scheduledAt, 'en-US', 'America/New_York');
    expect(instant).toMatch(/Jul\s*21,\s*2026/);
    expect(instant).not.toMatch(/Jul\s*22/);
    expect(instant).toMatch(/EDT|GMT-4|UTC-4/);
  });

  it('handles a positive UTC offset (Tokyo) without slipping the calendar day', () => {
    // 2026-07-21T15:00:00Z == 2026-07-22 12:00 AM JST (midnight in Tokyo)
    const midnightTokyo = '2026-07-21T15:00:00.000Z';
    const instant = formatScheduleNotificationInstant(midnightTokyo, 'en-US', 'Asia/Tokyo');
    expect(instant).toMatch(/Jul\s*22,\s*2026/);
    expect(instant).toMatch(/12:00\s*AM|00:00/);
    expect(instant).toMatch(/JST|GMT\+9|UTC\+9/);
  });

  it('keeps absolute wall time across a US daylight-saving spring-forward', () => {
    // 2026-03-08 02:00 local is skipped in America/New_York; 07:30Z is 02:30 EDT after the jump
    // (01:30 EST would be 06:30Z). Use a post-transition instant and assert the offset label.
    const afterSpringForward = '2026-03-08T07:30:00.000Z'; // 03:30 EDT
    const instant = formatScheduleNotificationInstant(afterSpringForward, 'en-US', 'America/New_York');
    expect(instant).toMatch(/Mar\s*8,\s*2026/);
    expect(instant).toMatch(/3:30\s*AM/);
    expect(instant).toMatch(/EDT|GMT-4|UTC-4/);
  });

  it('formats the same instant differently across viewer timezones', () => {
    const iso = '2026-07-22T00:00:00.000Z';
    const eastern = formatScheduleNotificationInstant(iso, 'en-US', 'America/New_York');
    const london = formatScheduleNotificationInstant(iso, 'en-GB', 'Europe/London');
    const tokyo = formatScheduleNotificationInstant(iso, 'en-US', 'Asia/Tokyo');
    expect(eastern).toMatch(/Jul\s*21/);
    expect(london).toMatch(/22/); // BST = UTC+1 → Jul 22 1:00 AM
    expect(tokyo).toMatch(/Jul\s*22/);
    expect(eastern).not.toEqual(london);
    expect(london).not.toEqual(tokyo);
  });

  it('detects venue (incl. VTT link), notes, duration, and time changes; ignores title-only', () => {
    expect(diffScheduleNotificationFields(base, { ...base, location: 'https://vtt.example/room/abc' })).toEqual([
      'venue',
    ]);
    expect(diffScheduleNotificationFields(base, { ...base, notes: 'new plan' })).toEqual(['notes']);
    expect(diffScheduleNotificationFields(base, { ...base, durationMinutes: 180 })).toEqual(['duration']);
    expect(
      diffScheduleNotificationFields(base, { ...base, scheduledAt: '2026-07-29T00:00:00.000Z' }),
    ).toEqual(['time']);
    expect(
      diffScheduleNotificationFields(base, {
        ...base,
        scheduledAt: '2026-07-29T00:00:00.000Z',
        location: 'Roll20',
        notes: 'level 5 sheets',
      }),
    ).toEqual(['time', 'venue', 'notes']);
    // Title is not part of ScheduleComparable — title-only edits yield no fields.
    expect(shouldNotifyScheduleUpdate([])).toBe(false);
    expect(shouldNotifyScheduleUpdate(['venue'])).toBe(true);
    expect(scheduleNotificationChangeType(['venue', 'notes'])).toBe('updated');
    expect(scheduleNotificationChangeType(['time', 'venue'])).toBe('rescheduled');
  });

  it('summarizes changed fields without leaking venue URLs or note bodies', () => {
    const summary = summarizeScheduleChangedFields(['venue', 'notes']);
    expect(summary).toBe('venue and notes');
    expect(summary).not.toMatch(/https?:/i);
    expect(summary).not.toMatch(/bring|snacks|level/i);

    const body = scheduleNotificationFallbackBody(
      data({ changeType: 'updated', changedFields: ['venue', 'notes'] }),
    );
    expect(body).toMatch(/venue and notes/i);
    expect(body).not.toMatch(/https?:/i);
    expect(body).not.toMatch(/bring snacks/i);
  });

  it('uses "Starts at …" so unknown instants stay grammatical', () => {
    expect(scheduleNotificationFallbackBody(data({ changeType: 'created' }))).toMatch(/^Starts at /);
    expect(
      scheduleNotificationFallbackBody(
        data({ changeType: 'created', scheduledAt: 'not-a-date' }),
      ),
    ).toBe('Starts at an unknown time.');
  });

  it('renders viewer-local titles for create/reschedule/update/cancel', () => {
    const locale = 'en-US';
    const tz = 'America/New_York';
    expect(formatScheduleNotificationTitle(data({ changeType: 'created' }), locale, tz)).toMatch(
      /Game night scheduled for .*Jul\s*21/,
    );
    expect(
      formatScheduleNotificationTitle(
        data({ changeType: 'rescheduled', changedFields: ['time'] }),
        locale,
        tz,
      ),
    ).toMatch(/rescheduled for .*Jul\s*21/);
    expect(
      formatScheduleNotificationTitle(
        data({ changeType: 'updated', changedFields: ['venue'] }),
        locale,
        tz,
      ),
    ).toMatch(/updated · .*Jul\s*21/);
    expect(formatScheduleNotificationTitle(data({ changeType: 'cancelled' }), locale, tz)).toMatch(
      /cancelled · was .*Jul\s*21/,
    );
    expect(formatScheduleNotificationBody(data({ changeType: 'cancelled' }))).toMatch(/removed from the calendar/i);
    expect(
      formatScheduleNotificationBody(data({ changeType: 'updated', changedFields: ['venue', 'notes'] })),
    ).toBe('Changed: venue and notes.');
  });

  it('keeps body empty when the title already carries the localized instant', () => {
    expect(formatScheduleNotificationBody(data({ changeType: 'created' }))).toBe('');
    expect(
      formatScheduleNotificationBody(
        data({ changeType: 'rescheduled', changedFields: ['time'] }),
      ),
    ).toBe('');
    expect(
      formatScheduleNotificationBody(
        data({ changeType: 'rescheduled', changedFields: ['time', 'venue'] }),
      ),
    ).toBe('Changed: time and venue.');
  });

  it('parses structured notification data and rejects malformed payloads', () => {
    const ok = parseScheduleNotificationData({
      kind: 'schedule',
      scheduleId: 11,
      scheduledAt: base.scheduledAt,
      durationMinutes: 240,
      changeType: 'cancelled',
      changedFields: [],
      label: 'Game night',
    });
    expect(ok?.changeType).toBe('cancelled');
    expect(parseScheduleNotificationData('{"kind":"schedule","scheduleId":11,"scheduledAt":"2026-07-22T00:00:00.000Z","durationMinutes":240,"changeType":"created","changedFields":[],"label":""}')?.changeType).toBe('created');
    expect(parseScheduleNotificationData(null)).toBeNull();
    expect(parseScheduleNotificationData('{not json')).toBeNull();
    expect(parseScheduleNotificationData({ kind: 'other' })).toBeNull();
    expect(
      parseScheduleNotificationData({
        kind: 'schedule',
        scheduleId: 11,
        scheduledAt: 'not-a-date',
        durationMinutes: 240,
        changeType: 'created',
        changedFields: [],
        label: 'Game night',
      }),
    ).toBeNull();
  });
});
