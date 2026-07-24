import { expect, test } from '@playwright/test';
import {
  initialRsvpSaveState,
  reduceRsvpSave,
  rsvpDisplayStatus,
  rsvpOptionDescription,
  rsvpOptions,
  rsvpSavedAnnouncement,
  rsvpStatusSummary,
  SCHEDULE_WHEN_HELP,
} from '../../src/features/sessions/schedulePanelA11y';

/**
 * Issue #645 — schedule RSVP vocabulary, optimistic save rollback, and form help.
 */

test.describe('schedule RSVP options (issue #645)', () => {
  test('exposes In / Maybe / Out with descriptive accessible names', () => {
    const opts = rsvpOptions();
    expect(opts.map((o) => o.status)).toEqual(['yes', 'maybe', 'no']);
    expect(opts.map((o) => o.label)).toEqual(['In', 'Maybe', 'Out']);
    for (const opt of opts) {
      expect(opt.description.length).toBeGreaterThan(opt.label.length);
      expect(opt.description).toBe(rsvpOptionDescription(opt.status));
    }
  });

  test('status summary matches dashboard RSVP vocabulary', () => {
    expect(rsvpStatusSummary(null)).toMatch(/no rsvp/i);
    expect(rsvpStatusSummary('yes')).toMatch(/you're in/i);
    expect(rsvpStatusSummary('maybe')).toMatch(/maybe/i);
    expect(rsvpStatusSummary('no')).toMatch(/you're out/i);
  });

  test('saved announcements name the chosen response', () => {
    expect(rsvpSavedAnnouncement('yes')).toMatch(/in/i);
    expect(rsvpSavedAnnouncement('maybe')).toMatch(/maybe/i);
    expect(rsvpSavedAnnouncement('no')).toMatch(/out/i);
  });
});

test.describe('schedule RSVP optimistic save (issue #645)', () => {
  test('shows the pending pick while saving, then reverts on failure', () => {
    let state = initialRsvpSaveState('yes');
    expect(rsvpDisplayStatus(state)).toBe('yes');

    state = reduceRsvpSave(state, { type: 'select', status: 'no' });
    expect(state.phase).toBe('saving');
    expect(rsvpDisplayStatus(state)).toBe('no');

    state = reduceRsvpSave(state, { type: 'failed' });
    expect(state.phase).toBe('idle');
    expect(rsvpDisplayStatus(state)).toBe('yes');
  });

  test('commits the pick after a successful save', () => {
    let state = initialRsvpSaveState(null);
    state = reduceRsvpSave(state, { type: 'select', status: 'maybe' });
    state = reduceRsvpSave(state, { type: 'saved', status: 'maybe' });
    expect(rsvpDisplayStatus(state)).toBe('maybe');
    expect(state.pending).toBeNull();
  });

  test('ignores duplicate selects while a save is in flight', () => {
    let state = initialRsvpSaveState('yes');
    state = reduceRsvpSave(state, { type: 'select', status: 'maybe' });
    state = reduceRsvpSave(state, { type: 'select', status: 'no' });
    expect(rsvpDisplayStatus(state)).toBe('maybe');
  });
});

test.describe('schedule form help (issue #645)', () => {
  test('When field help mentions local timezone', () => {
    expect(SCHEDULE_WHEN_HELP.toLowerCase()).toContain('timezone');
  });
});


// -------------------- RSVP note editor (issue #552) --------------------

import {
  RSVP_NOTE_HELP,
  RSVP_NOTE_LABEL,
  RSVP_NOTE_MAX_LEN,
  RSVP_NOTE_SAVED_ANNOUNCEMENT,
  RSVP_NOTE_CLEARED_ANNOUNCEMENT,
  RSVP_NOTE_SAVE_FAILED_ANNOUNCEMENT,
  rsvpNoteSaveRequest,
  rsvpNoteTooLongMessage,
  syncRsvpNoteDraft,
} from '../../src/features/sessions/schedulePanelA11y';

test.describe('RSVP note editor copy (issue #552)', () => {
  test('label + help are non-empty and mention that others can see it', () => {
    expect(RSVP_NOTE_LABEL).toMatch(/rsvp note/i);
    expect(RSVP_NOTE_LABEL).toMatch(/optional/i);
    expect(RSVP_NOTE_HELP).toMatch(/DM|table|member/i);
  });

  test('announcements cover saved, cleared, and failed outcomes', () => {
    expect(RSVP_NOTE_SAVED_ANNOUNCEMENT).toMatch(/saved/i);
    expect(RSVP_NOTE_CLEARED_ANNOUNCEMENT).toMatch(/cleared/i);
    expect(RSVP_NOTE_SAVE_FAILED_ANNOUNCEMENT).toMatch(/couldn't|failed|error/i);
  });

  test('too-long message states current and max length', () => {
    const msg = rsvpNoteTooLongMessage(600, RSVP_NOTE_MAX_LEN);
    expect(msg).toContain('600');
    expect(msg).toContain(String(RSVP_NOTE_MAX_LEN));
  });
});

test.describe('rsvpNoteSaveRequest (issue #552)', () => {
  test('returns null when no RSVP has been picked yet', () => {
    expect(rsvpNoteSaveRequest(null, '', 'some new note')).toBeNull();
  });

  test('returns null when the trimmed draft matches the persisted note (no-op)', () => {
    // Exact match
    expect(rsvpNoteSaveRequest('yes', 'running late', 'running late')).toBeNull();
    // Whitespace-only difference — trimming turns them into the same string,
    // so a save would be a no-op.
    expect(rsvpNoteSaveRequest('yes', 'running late', '  running late  ')).toBeNull();
  });

  test('sends the trimmed note when it differs', () => {
    const req = rsvpNoteSaveRequest('maybe', '', 'might be 30 late');
    expect(req).toEqual({ status: 'maybe', note: 'might be 30 late' });
  });

  test('sends empty string to explicitly clear an existing note', () => {
    const req = rsvpNoteSaveRequest('yes', 'brought snacks', '');
    expect(req).toEqual({ status: 'yes', note: '' });
    expect(rsvpNoteSaveRequest('yes', 'brought snacks', '   ')).toEqual({ status: 'yes', note: '' });
  });

  test('clears a whitespace-only persisted note when the draft is empty', () => {
    expect(rsvpNoteSaveRequest('yes', '   ', '')).toEqual({ status: 'yes', note: '' });
    expect(rsvpNoteSaveRequest('yes', '   ', '   ')).toBeNull();
  });

  test('preserves the caller-picked status regardless of prior state', () => {
    // A user changing status AND note in the same edit must send both.
    const req = rsvpNoteSaveRequest('no', 'planning to attend', 'sorry, sick');
    expect(req).toEqual({ status: 'no', note: 'sorry, sick' });
  });
});

test.describe('syncRsvpNoteDraft (issue #552)', () => {
  test('resets the draft when the schedule row changes', () => {
    expect(syncRsvpNoteDraft('local edit', 'old note', 'new note', true)).toBe('new note');
  });

  test('adopts a server refresh when the draft still matches the last synced value', () => {
    expect(syncRsvpNoteDraft('note A', 'note A', 'note B', false)).toBe('note B');
  });

  test('preserves in-flight typing when the draft diverged from the last synced value', () => {
    expect(syncRsvpNoteDraft('typing…', 'note A', 'note B', false)).toBe('typing…');
  });
});
