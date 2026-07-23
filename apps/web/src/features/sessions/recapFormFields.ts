/**
 * Session recap create/edit field contract (issue #859).
 *
 * Title, Played on, and Recap used to rely on placeholders or visually adjacent
 * text without stable id ↔ label associations. This module owns the shared
 * vocabulary, id shape, optional/help copy, and client validation used by both
 * forms so accessible names and error focus stay consistent.
 */

export const RECAP_FIELD_LABELS = {
  title: 'Title',
  // Visible copy is "Played on"; the key matches the API/schema field `playedAt`.
  playedAt: 'Played on',
  recap: 'Recap',
} as const;

/** Schema ceilings from `@campfire/schema` Session.title / Session.recap. */
export const RECAP_TITLE_MAX = 200;
export const RECAP_BODY_MAX = 100_000;

/** Date semantics live in help text — never only in a placeholder (issue #859). */
export const RECAP_PLAYED_ON_HELP =
  'Local calendar day the table played — not a timezone timestamp. Leave blank if undated.';

export const RECAP_TITLE_HELP = 'Short name for the session log entry.';
export const RECAP_BODY_HELP = 'Markdown is fine — headings and bullets render in the recap view.';

export type RecapFieldIds = {
  controlId: string;
  helpId: string;
  errorId: string;
};

export type RecapFormFieldIds = {
  title: RecapFieldIds;
  playedAt: RecapFieldIds;
  recap: RecapFieldIds;
  formErrorId: string;
};

function fieldIds(prefix: string, name: string): RecapFieldIds {
  return {
    controlId: `${prefix}-${name}`,
    helpId: `${prefix}-${name}-help`,
    errorId: `${prefix}-${name}-error`,
  };
}

/** Stable ids for the create (+ Add recap) form. */
export function newRecapFieldIds(): RecapFormFieldIds {
  const prefix = 'new-recap';
  return {
    // Keep historical control ids from the create form so existing e2e locators
    // (`#new-recap-title`, `#new-recap-played-at`, `#new-recap-body`) stay valid.
    title: fieldIds(prefix, 'title'),
    playedAt: fieldIds(prefix, 'played-at'),
    recap: {
      controlId: `${prefix}-body`,
      helpId: `${prefix}-body-help`,
      errorId: `${prefix}-body-error`,
    },
    formErrorId: `${prefix}-form-error`,
  };
}

/** Stable ids for the edit form of one session. */
export function editRecapFieldIds(sessionId: number): RecapFormFieldIds {
  const prefix = `session-${sessionId}`;
  return {
    title: fieldIds(prefix, 'title'),
    playedAt: fieldIds(prefix, 'played-at'),
    // Historical id for the recap textarea (already wired before #859).
    recap: {
      controlId: `${prefix}-recap`,
      helpId: `${prefix}-recap-help`,
      errorId: `${prefix}-recap-error`,
    },
    formErrorId: `${prefix}-form-error`,
  };
}

export type RecapFieldErrors = {
  title?: string;
  playedAt?: string;
  recap?: string;
};

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidCalendarDate(value: string): boolean {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const local = new Date(year, month, day);
  return local.getFullYear() === year && local.getMonth() === month && local.getDate() === day;
}

/** Client-side field validation before create/update. */
export function validateRecapFields(values: {
  title: string;
  playedAt: string;
  recap: string;
}): RecapFieldErrors {
  const errors: RecapFieldErrors = {};
  if (values.title.length > RECAP_TITLE_MAX) {
    errors.title = `Title must be at most ${RECAP_TITLE_MAX} characters.`;
  }
  if (values.playedAt && !isValidCalendarDate(values.playedAt)) {
    errors.playedAt = 'Enter a valid calendar date.';
  }
  if (values.recap.length > RECAP_BODY_MAX) {
    errors.recap = `Recap must be at most ${RECAP_BODY_MAX.toLocaleString()} characters.`;
  }
  return errors;
}

/** First invalid control id in Title → Played on → Recap order. */
export function firstInvalidRecapControlId(
  errors: RecapFieldErrors,
  ids: RecapFormFieldIds,
): string | null {
  if (errors.title) return ids.title.controlId;
  if (errors.playedAt) return ids.playedAt.controlId;
  if (errors.recap) return ids.recap.controlId;
  return null;
}

/** Build aria-describedby from help + field error + optional form error. */
export function recapDescribedBy(
  ids: RecapFieldIds,
  options: { help?: boolean; error?: boolean; formErrorId?: string | null } = {},
): string | undefined {
  const parts = [
    options.help === false ? null : ids.helpId,
    options.error ? ids.errorId : null,
    options.formErrorId || null,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}
