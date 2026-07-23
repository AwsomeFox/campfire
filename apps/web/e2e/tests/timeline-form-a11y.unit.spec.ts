import { expect, test } from '@playwright/test';
import {
  TIMELINE_BODY_HELP,
  TIMELINE_BODY_LABEL,
  TIMELINE_DATE_HELP,
  TIMELINE_DM_SECRET_HELP,
  TIMELINE_DM_SECRET_LABEL,
  TIMELINE_EDIT_FORM_PREFIX,
  TIMELINE_NEW_FORM_PREFIX,
  TIMELINE_ORDER_HELP,
  TIMELINE_ORDER_INTEGER_ERROR,
  TIMELINE_ORDER_LABEL,
  TIMELINE_TITLE_REQUIRED_ERROR,
  firstTimelineFieldErrorId,
  timelineFieldErrorId,
  timelineFieldHelpId,
  timelineFieldId,
  validateTimelineEventDraft,
} from '../../src/features/timeline/timelineFormA11y';

/**
 * Issue #453 — Timeline create/edit field labels, help, and validation copy.
 */

test.describe('timeline form a11y vocabulary (issue #453)', () => {
  test('uses stable create/edit id prefixes and field suffixes', () => {
    expect(TIMELINE_NEW_FORM_PREFIX).toBe('timeline-event-new');
    expect(TIMELINE_EDIT_FORM_PREFIX).toBe('timeline-event-edit');
    expect(timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'order')).toBe('timeline-event-new-order');
    expect(timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'body')).toBe('timeline-event-edit-body');
    expect(timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'dmSecret')).toBe('timeline-event-new-dmSecret');
    expect(timelineFieldHelpId(TIMELINE_NEW_FORM_PREFIX, 'order')).toBe('timeline-event-new-order-help');
    expect(timelineFieldErrorId(TIMELINE_EDIT_FORM_PREFIX, 'title')).toBe('timeline-event-edit-title-error');
  });

  test('names Order / Description / DM secret and explains format, order, and secrecy', () => {
    expect(TIMELINE_ORDER_LABEL).toBe('Order');
    expect(TIMELINE_ORDER_HELP.toLowerCase()).toMatch(/sequence|order/);
    expect(TIMELINE_ORDER_HELP.toLowerCase()).toMatch(/fantasy|sortable|date/);
    expect(TIMELINE_DATE_HELP.toLowerCase()).toMatch(/free-text|calendar|format/);
    expect(TIMELINE_BODY_LABEL).toBe('Description');
    expect(TIMELINE_BODY_HELP.toLowerCase()).toMatch(/markdown/);
    expect(TIMELINE_DM_SECRET_LABEL).toBe('DM secret');
    expect(TIMELINE_DM_SECRET_HELP.toLowerCase()).toMatch(/players never|stripped|non-dm/);
    expect(TIMELINE_DM_SECRET_HELP.toLowerCase()).toMatch(/hidden/);
  });
});

test.describe('timeline event draft validation (issue #453)', () => {
  test('requires a title and a whole-number order', () => {
    expect(validateTimelineEventDraft({ title: '', sortIndex: '10' })).toEqual({
      title: TIMELINE_TITLE_REQUIRED_ERROR,
    });
    expect(validateTimelineEventDraft({ title: 'The Sundering', sortIndex: '' })).toEqual({
      order: TIMELINE_ORDER_INTEGER_ERROR,
    });
    expect(validateTimelineEventDraft({ title: 'The Sundering', sortIndex: '1.5' })).toEqual({
      order: TIMELINE_ORDER_INTEGER_ERROR,
    });
    expect(validateTimelineEventDraft({ title: 'The Sundering', sortIndex: 'abc' })).toEqual({
      order: TIMELINE_ORDER_INTEGER_ERROR,
    });
    expect(validateTimelineEventDraft({ title: 'The Sundering', sortIndex: '-3' })).toEqual({});
    expect(validateTimelineEventDraft({ title: '  Keep  ', sortIndex: '0' })).toEqual({});
  });

  test('focuses title before order when both fields are invalid', () => {
    expect(
      firstTimelineFieldErrorId(TIMELINE_NEW_FORM_PREFIX, {
        title: TIMELINE_TITLE_REQUIRED_ERROR,
        order: TIMELINE_ORDER_INTEGER_ERROR,
      }),
    ).toBe('timeline-event-new-title');
    expect(
      firstTimelineFieldErrorId(TIMELINE_EDIT_FORM_PREFIX, {
        order: TIMELINE_ORDER_INTEGER_ERROR,
      }),
    ).toBe('timeline-event-edit-order');
    expect(firstTimelineFieldErrorId(TIMELINE_NEW_FORM_PREFIX, {})).toBeNull();
  });
});
