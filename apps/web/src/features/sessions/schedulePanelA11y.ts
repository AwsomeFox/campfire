/**
 * Schedule panel accessible names + RSVP save copy (issue #645).
 *
 * SchedulePanel used placeholder-only session fields and styled buttons for
 * RSVP without radiogroup semantics or spoken save outcomes. These pure helpers
 * own the stable form id contract, RSVP vocabulary, and announcement strings
 * so unit tests can pin behavior without a browser. SchedulePanel builds an
 * id prefix as `${SCHEDULE_FORM_ID_PREFIX}-${sessionId}` when editing or
 * `${SCHEDULE_FORM_ID_PREFIX}-${sanitizedUseId}` on create; each labeled control
 * then uses Field.fieldIds — `${idPrefix}-${fieldName}` for the input (+ `-help` /
 * `-error`), with fieldName from SCHEDULE_FIELD_NAMES.
 */
import type { RsvpStatus } from '@campfire/schema';

export const SCHEDULE_FORM_ID_PREFIX = 'schedule-form';

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

/** Local datetime string for `<input type="datetime-local">` (no timezone suffix). */
export function formatDatetimeLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO instant → value for `<input type="datetime-local">` in the viewer's local time. */
export function isoToDatetimeLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatDatetimeLocalInputValue(d);
}

/**
 * Relative datetime-local value for Playwright fills (days from today at hour:minute).
 * Callers that need a guaranteed-future instant should pass days >= 1.
 */
export function datetimeLocalDaysFromNow(days: number, hour = 18, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return formatDatetimeLocalInputValue(d);
}

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


// -------------------- RSVP note (issue #552) --------------------
//
// The scheduling API has always accepted an optional per-RSVP note ("30 min
// late", "can only stay for the first fight"), but the web UI had no input
// for it. These constants back a compact note editor beside the RSVP
// segmented control. Server semantics: when a status change omits the note
// field the existing note is preserved; sending an empty string clears it.

/** Max chars — matches the server RsvpSet.note schema. */
export const RSVP_NOTE_MAX_LEN = 500;

/** Persistent visible label (never rely on placeholder-only). */
export const RSVP_NOTE_LABEL = 'RSVP note (optional)';

/** Descriptive help copy shown near the field. */
export const RSVP_NOTE_HELP =
  'Share timing or context with the table — e.g. "30 min late" or "can only stay for the first fight". The DM and other members can see this.';

/** Placeholder used inside the input. Visible label is separate. */
export const RSVP_NOTE_PLACEHOLDER = 'e.g. 30 min late';

/** Button label to save a changed note. */
export const RSVP_NOTE_SAVE_LABEL = 'Save note';

/** Button label to clear an existing note. */
export const RSVP_NOTE_CLEAR_LABEL = 'Clear note';

/** aria-live announcement while saving. */
export const RSVP_NOTE_SAVING_STATUS = 'Saving RSVP note…';

/** aria-live announcement after a successful save. */
export const RSVP_NOTE_SAVED_ANNOUNCEMENT = 'RSVP note saved.';

/** aria-live announcement after a successful clear. */
export const RSVP_NOTE_CLEARED_ANNOUNCEMENT = 'RSVP note cleared.';

/** aria-live announcement + inline error on save failure. */
export const RSVP_NOTE_SAVE_FAILED_ANNOUNCEMENT = "Couldn't save your RSVP note.";

/** aria-live announcement when the note exceeds the max length. */
export function rsvpNoteTooLongMessage(current: number, max: number = RSVP_NOTE_MAX_LEN): string {
  return `Note is ${current} of ${max} characters — trim to ${max} to save.`;
}

/**
 * Pure helper for what to send on a note edit save (#552). The server
 * preserves the existing note when the field is omitted and clears it when
 * the value is an empty string — surface both cases so the caller knows
 * whether to fire the request at all.
 *
 * Returns null when the trimmed value equals the persisted value (no-op).
 */
export function rsvpNoteSaveRequest(
  status: RsvpStatus | null,
  persistedNote: string,
  draft: string,
): { status: RsvpStatus; note: string } | null {
  if (!status) return null;
  const trimmed = draft.trim();
  const persistedTrimmed = persistedNote.trim();
  if (trimmed === persistedTrimmed) {
    // Whitespace-only persisted notes trim to '' but still occupy server storage —
    // an empty draft must clear them.
    if (trimmed === '' && persistedNote !== '') return { status, note: '' };
    return null;
  }
  return { status, note: trimmed };
}

/**
 * Reconcile a local RSVP-note draft with a server refresh (#552). When the
 * schedule row changes, always take the authoritative note. Otherwise preserve
 * in-flight typing only while the draft still matches what we last synced from.
 */
export function syncRsvpNoteDraft(
  draft: string,
  lastSyncedPersisted: string,
  nextPersisted: string,
  scheduleChanged: boolean,
): string {
  if (scheduleChanged) return nextPersisted;
  return draft.trim() === lastSyncedPersisted.trim() ? nextPersisted : draft;
}
