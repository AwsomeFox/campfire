/**
 * Schedule panel accessible names + RSVP save copy (issue #645).
 *
 * SchedulePanel used placeholder-only session fields and styled buttons for
 * RSVP without radiogroup semantics or spoken save outcomes. These pure helpers
 * own the stable form id contract, RSVP vocabulary, and announcement strings
 * so unit tests can pin behavior without a browser.
 */
import type { RsvpStatus } from '@campfire/schema';

export const SCHEDULE_FORM_ID_PREFIX = 'schedule-form';
/** Per-instance suffix: session id when editing, or sanitized useId() for create. */

/** Stable form `name` / id suffix values for create + edit session forms. */
export const SCHEDULE_FIELD_NAMES = {
  when: 'when',
  durationMinutes: 'durationMinutes',
  title: 'title',
  location: 'location',
  notes: 'notes',
} as const;

export const SCHEDULE_WHEN_HELP =
  'Date and time in your local timezone — the table sees the same instant converted for their locale.';

export const SCHEDULE_DURATION_HELP =
  'Length of the game night in minutes (15-minute steps when scheduling; edits may end a session early).';

export const SCHEDULE_TITLE_HELP = 'Optional label shown on the dashboard and calendar feed.';

export const SCHEDULE_LOCATION_HELP =
  'Optional — in-person address, VTT link, or voice channel.';

export const SCHEDULE_NOTES_HELP =
  'Optional prep for the table — bring sheets, start time, house rules.';

/** Visible legend copy; also referenced by the RSVP radiogroup via aria-labelledby. */
export const RSVP_GROUP_LEGEND = 'Can you make it?';

export const RSVP_STATUSES: readonly RsvpStatus[] = ['yes', 'maybe', 'no'];

export type RsvpOption = {
  status: RsvpStatus;
  /** Short visible label on the segmented control. */
  label: string;
  /** Full accessible name for role="radio" (must not be ambiguous alone). */
  description: string;
};

const RSVP_SHORT: Record<RsvpStatus, string> = {
  yes: 'In',
  maybe: 'Maybe',
  no: 'Out',
};

/** RSVP segmented-control options in yes → maybe → no order. */
export function rsvpOptions(): readonly RsvpOption[] {
  return RSVP_STATUSES.map((status) => ({
    status,
    label: RSVP_SHORT[status],
    description: rsvpOptionDescription(status),
  }));
}

export function rsvpOptionDescription(status: RsvpStatus): string {
  switch (status) {
    case 'yes':
      return 'In — I can make this session';
    case 'maybe':
      return 'Maybe — I might make this session';
    case 'no':
      return 'Out — I cannot make this session';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return status;
    }
  }
}

/** Status line beside the RSVP group (mirrors dashboard cue vocabulary). */
export function rsvpStatusSummary(status: RsvpStatus | null | undefined): string {
  if (!status) return 'No RSVP selected yet.';
  switch (status) {
    case 'yes':
      return "You're in for this session.";
    case 'maybe':
      return 'Maybe for this session.';
    case 'no':
      return "You're out for this session.";
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 'No RSVP selected yet.';
    }
  }
}

export const RSVP_SAVING_STATUS = 'Saving RSVP…';

export function rsvpSavedAnnouncement(status: RsvpStatus): string {
  switch (status) {
    case 'yes':
      return 'RSVP saved: you are in.';
    case 'maybe':
      return 'RSVP saved: maybe.';
    case 'no':
      return 'RSVP saved: you are out.';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 'RSVP saved.';
    }
  }
}

export const RSVP_SAVE_FAILED_ANNOUNCEMENT = "Couldn't save your RSVP.";

export const SESSION_SAVE_FAILED_ANNOUNCEMENT = "Couldn't save the session.";

export function sessionScheduledAnnouncement(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Session scheduled: ${trimmed}.` : 'Session scheduled.';
}

export function sessionUpdatedAnnouncement(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Session updated: ${trimmed}.` : 'Session updated.';
}

export type RsvpSavePhase = 'idle' | 'saving';

/** Optimistic RSVP UI while a PUT is in flight (issue #645 rollback). */
export type RsvpSaveState = {
  /** Last server-confirmed status for the viewer (null = unanswered). */
  persisted: RsvpStatus | null;
  /** In-flight pick; cleared on success or failure. */
  pending: RsvpStatus | null;
  phase: RsvpSavePhase;
};

export const initialRsvpSaveState = (persisted: RsvpStatus | null): RsvpSaveState => ({
  persisted,
  pending: null,
  phase: 'idle',
});

/** Value the radiogroup should reflect (pending wins during save). */
export function rsvpDisplayStatus(state: RsvpSaveState): RsvpStatus | null {
  return state.pending ?? state.persisted;
}

export type RsvpSaveEvent =
  | { type: 'sync'; persisted: RsvpStatus | null }
  | { type: 'select'; status: RsvpStatus }
  | { type: 'saved'; status: RsvpStatus }
  | { type: 'failed' };

export function reduceRsvpSave(state: RsvpSaveState, event: RsvpSaveEvent): RsvpSaveState {
  switch (event.type) {
    case 'sync':
      // Drop stale optimistic state when the schedule row reloads from the server.
      if (state.phase === 'saving') return state;
      return { persisted: event.persisted, pending: null, phase: 'idle' };
    case 'select':
      if (state.phase === 'saving') return state;
      if (event.status === state.persisted && state.pending == null) return state;
      return { ...state, pending: event.status, phase: 'saving' };
    case 'saved':
      return { persisted: event.status, pending: null, phase: 'idle' };
    case 'failed':
      return { persisted: state.persisted, pending: null, phase: 'idle' };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}
