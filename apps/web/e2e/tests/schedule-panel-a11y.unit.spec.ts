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
