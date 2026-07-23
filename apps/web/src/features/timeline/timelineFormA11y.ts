/**
 * Timeline event authoring a11y vocabulary + draft validation (issue #453).
 *
 * Kept as plain strings/helpers so unit specs can pin accessible names, help
 * copy, and field-error messages without mounting the page. The create/edit
 * forms share the same field suffixes under distinct id prefixes.
 */

export const TIMELINE_NEW_FORM_PREFIX = 'timeline-event-new';
export const TIMELINE_EDIT_FORM_PREFIX = 'timeline-event-edit';

export type TimelineEventField =
  | 'title'
  | 'inWorldDate'
  | 'era'
  | 'order'
  | 'body'
  | 'dmSecret'
  | 'hidden';

export function timelineFieldId(prefix: string, field: TimelineEventField): string {
  return `${prefix}-${field}`;
}

export function timelineFieldHelpId(prefix: string, field: TimelineEventField): string {
  return `${prefix}-${field}-help`;
}

export function timelineFieldErrorId(prefix: string, field: TimelineEventField): string {
  return `${prefix}-${field}-error`;
}

/** Visible label for the DM-controlled sort index (spinbutton / number input). */
export const TIMELINE_ORDER_LABEL = 'Order';

/**
 * Explains why Order exists: free-text fantasy dates are not sortable, so the
 * DM sequences events with this integer.
 */
export const TIMELINE_ORDER_HELP =
  'Whole number controlling timeline sequence (lower appears earlier). Fantasy dates are not sortable, so Order — not the date text — sets narrative order.';

/** Free-text in-fiction date format guidance. */
export const TIMELINE_DATE_HELP =
  'Free-text in-world date (any calendar format). Leave blank for an undated beat sequenced only by Order.';

export const TIMELINE_BODY_LABEL = 'Description';

export const TIMELINE_BODY_HELP = 'Optional markdown shown on the public timeline entry.';

export const TIMELINE_DM_SECRET_LABEL = 'DM secret';

/**
 * Secrecy explanation: players never receive this field (server strips it for
 * non-DM reads). Distinct from the Hidden checkbox, which hides the whole event.
 */
export const TIMELINE_DM_SECRET_HELP =
  'Visible only to DMs. Players never receive this text — it is stripped from every non-DM API response. Use Hidden (below) to hide the entire event until a reveal.';

export const TIMELINE_TITLE_REQUIRED_ERROR = 'An event needs a title.';
export const TIMELINE_ORDER_INTEGER_ERROR = 'Order must be a whole number.';

export type TimelineEventDraftFields = {
  title: string;
  sortIndex: string;
};

export type TimelineEventFieldErrors = Partial<Record<'title' | 'order', string>>;

/** Client-side field validation before create/save. */
export function validateTimelineEventDraft(draft: TimelineEventDraftFields): TimelineEventFieldErrors {
  const errors: TimelineEventFieldErrors = {};
  if (!draft.title.trim()) {
    errors.title = TIMELINE_TITLE_REQUIRED_ERROR;
  }
  const trimmedOrder = draft.sortIndex.trim();
  if (trimmedOrder === '' || !/^-?\d+$/.test(trimmedOrder)) {
    errors.order = TIMELINE_ORDER_INTEGER_ERROR;
  }
  return errors;
}

/** First invalid field id for logical focus after validation failure. */
export function firstTimelineFieldErrorId(
  prefix: string,
  errors: TimelineEventFieldErrors,
): string | null {
  if (errors.title) return timelineFieldId(prefix, 'title');
  if (errors.order) return timelineFieldId(prefix, 'order');
  return null;
}
