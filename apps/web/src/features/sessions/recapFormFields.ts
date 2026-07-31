/**
 * Session recap create/edit field contract (issue #859).
 *
 * Title, Played on, and Recap used to rely on placeholders or visually adjacent
 * text without stable id ↔ label associations. This module owns the shared
 * vocabulary, id shape, optional/help copy, and client validation used by both
 * forms so accessible names and error focus stay consistent.
 */

import { formatNumber } from '../../lib/format';

export const RECAP_FIELD_LABELS = {
  title: 'Title',
  // Visible copy is "Played on"; the key matches the API/schema field `playedAt`.
  playedAt: 'Played on',
  recap: 'Recap',
  dmSecret: 'DM prep notes',
} as const;

/** Schema ceilings from `@campfire/schema` Session.title / Session.recap / Session.dmSecret. */
export const RECAP_TITLE_MAX = 200;
export const RECAP_BODY_MAX = 100_000;
export const RECAP_DM_SECRET_MAX = 20_000;

/** Date semantics live in help text — never only in a placeholder (issue #859). */
export const RECAP_PLAYED_ON_HELP =
  'Local calendar day the table played — not a timezone timestamp. Leave blank if undated.';

export const RECAP_TITLE_HELP = 'Short name for the session log entry.';
export const RECAP_BODY_HELP = 'Markdown is fine — headings and bullets render in the recap view.';
export const RECAP_DM_SECRET_HELP = 'DM-only prep notes and secrets. Stripped for players and non-DMs.';

export type RecapFieldIds = {
  controlId: string;
  helpId: string;
  errorId: string;
};

export type RecapFormFieldIds = {
  title: RecapFieldIds;
  playedAt: RecapFieldIds;
  recap: RecapFieldIds;
  dmSecret: RecapFieldIds;
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
    dmSecret: {
      controlId: `${prefix}-dm-secret`,
      helpId: `${prefix}-dm-secret-help`,
      errorId: `${prefix}-dm-secret-error`,
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
    dmSecret: {
      controlId: `${prefix}-dm-secret`,
      helpId: `${prefix}-dm-secret-help`,
      errorId: `${prefix}-dm-secret-error`,
    },
    formErrorId: `${prefix}-form-error`,
  };
}

export type RecapFieldErrors = {
  title?: string;
  playedAt?: string;
  recap?: string;
  dmSecret?: string;
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
  dmSecret?: string;
}): RecapFieldErrors {
  const errors: RecapFieldErrors = {};
  if (values.title.length > RECAP_TITLE_MAX) {
    errors.title = `Title must be at most ${RECAP_TITLE_MAX} characters.`;
  }
  if (values.playedAt && !isValidCalendarDate(values.playedAt)) {
    errors.playedAt = 'Enter a valid calendar date.';
  }
  if (values.recap.length > RECAP_BODY_MAX) {
    errors.recap = `Recap must be at most ${formatNumber(RECAP_BODY_MAX)} characters.`;
  }
  if (values.dmSecret && values.dmSecret.length > RECAP_DM_SECRET_MAX) {
    errors.dmSecret = `DM prep notes must be at most ${formatNumber(RECAP_DM_SECRET_MAX)} characters.`;
  }
  return errors;
}

/** First invalid control id in Title → Played on → Recap → DM prep notes order. */
export function firstInvalidRecapControlId(
  errors: RecapFieldErrors,
  ids: RecapFormFieldIds,
): string | null {
  if (errors.title) return ids.title.controlId;
  if (errors.playedAt) return ids.playedAt.controlId;
  if (errors.recap) return ids.recap.controlId;
  if (errors.dmSecret) return ids.dmSecret.controlId;
  return null;
}

/** Recap editor draft snapshot for protected-form persistence (issue #641). */
export type RecapEditorDraft = {
  title: string;
  playedAt: string;
  recap: string;
  dmSecret?: string;
  scheduledSessionId?: number | null;
};

export const EMPTY_RECAP_EDITOR_DRAFT: RecapEditorDraft = {
  title: '',
  playedAt: '',
  recap: '',
  dmSecret: '',
  scheduledSessionId: null,
};

export function recapEditorDraftFromSession(input: {
  title: string;
  playedAt: string | null;
  recap: string;
  dmSecret?: string;
  scheduledSessionId?: number | null;
}): RecapEditorDraft {
  return {
    title: input.title,
    playedAt: input.playedAt ? input.playedAt.slice(0, 10) : '',
    recap: input.recap,
    dmSecret: input.dmSecret ?? '',
    scheduledSessionId: input.scheduledSessionId ?? null,
  };
}

export function isRecapEditorDirty(draft: RecapEditorDraft, baseline: RecapEditorDraft): boolean {
  return !recapEditorDraftsEqual(draft, baseline);
}

export function recapEditorDraftsEqual(a: RecapEditorDraft, b: RecapEditorDraft): boolean {
  return (
    a.title === b.title &&
    a.playedAt === b.playedAt &&
    a.recap === b.recap &&
    (a.dmSecret ?? '') === (b.dmSecret ?? '') &&
    (a.scheduledSessionId ?? null) === (b.scheduledSessionId ?? null)
  );
}

export function isNewRecapDraftMeaningful(draft: RecapEditorDraft): boolean {
  return (
    draft.title.trim() !== '' ||
    draft.recap.trim() !== '' ||
    draft.playedAt.trim() !== '' ||
    (draft.dmSecret ?? '').trim() !== ''
  );
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
