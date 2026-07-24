import { expect, test } from '@playwright/test';
import {
  RECAP_BODY_HELP,
  RECAP_BODY_MAX,
  RECAP_FIELD_LABELS,
  RECAP_PLAYED_ON_HELP,
  RECAP_TITLE_HELP,
  RECAP_TITLE_MAX,
  editRecapFieldIds,
  firstInvalidRecapControlId,
  newRecapFieldIds,
  recapDescribedBy,
  validateRecapFields,
} from '../../src/features/sessions/recapFormFields';

/**
 * Issue #859 — session recap form field contract.
 *
 * Pins stable ids, shared labels, optional/help copy, and client validation so
 * create/edit accessible names and first-invalid focus cannot drift apart.
 */

test.describe('recap form field contract (issue #859)', () => {
  test('uses consistent Title / Played on / Recap labels', () => {
    expect(RECAP_FIELD_LABELS).toEqual({
      title: 'Title',
      playedAt: 'Played on',
      recap: 'Recap',
    });
  });

  test('keeps create-form control ids stable for existing locators', () => {
    expect(newRecapFieldIds()).toEqual({
      title: {
        controlId: 'new-recap-title',
        helpId: 'new-recap-title-help',
        errorId: 'new-recap-title-error',
      },
      playedAt: {
        controlId: 'new-recap-played-at',
        helpId: 'new-recap-played-at-help',
        errorId: 'new-recap-played-at-error',
      },
      recap: {
        controlId: 'new-recap-body',
        helpId: 'new-recap-body-help',
        errorId: 'new-recap-body-error',
      },
      formErrorId: 'new-recap-form-error',
    });
  });

  test('builds edit-form ids from the session id, including the historical recap id', () => {
    expect(editRecapFieldIds(42)).toEqual({
      title: {
        controlId: 'session-42-title',
        helpId: 'session-42-title-help',
        errorId: 'session-42-title-error',
      },
      playedAt: {
        controlId: 'session-42-played-at',
        helpId: 'session-42-played-at-help',
        errorId: 'session-42-played-at-error',
      },
      recap: {
        controlId: 'session-42-recap',
        helpId: 'session-42-recap-help',
        errorId: 'session-42-recap-error',
      },
      formErrorId: 'session-42-form-error',
    });
  });

  test('explains date semantics and optional-field help outside placeholders', () => {
    expect(RECAP_PLAYED_ON_HELP).toMatch(/local calendar day/i);
    expect(RECAP_PLAYED_ON_HELP).toMatch(/not a timezone timestamp/i);
    expect(RECAP_PLAYED_ON_HELP).toMatch(/leave blank/i);
    expect(RECAP_TITLE_HELP.length).toBeGreaterThan(8);
    expect(RECAP_BODY_HELP).toMatch(/markdown/i);
  });

  test('validateRecapFields accepts empty optional values and valid dates', () => {
    expect(validateRecapFields({ title: '', playedAt: '', recap: '' })).toEqual({});
    expect(validateRecapFields({ title: 'Night raid', playedAt: '2026-07-21', recap: '## Recap' })).toEqual({});
  });

  test('validateRecapFields rejects over-long title/body and invalid calendar dates', () => {
    expect(validateRecapFields({ title: 'x'.repeat(RECAP_TITLE_MAX + 1), playedAt: '', recap: '' })).toEqual({
      title: `Title must be at most ${RECAP_TITLE_MAX} characters.`,
    });
    expect(validateRecapFields({ title: '', playedAt: '2026-02-31', recap: '' })).toEqual({
      playedAt: 'Enter a valid calendar date.',
    });
    expect(validateRecapFields({ title: '', playedAt: 'not-a-date', recap: '' })).toEqual({
      playedAt: 'Enter a valid calendar date.',
    });
    expect(
      validateRecapFields({ title: '', playedAt: '', recap: 'y'.repeat(RECAP_BODY_MAX + 1) }).recap,
    ).toMatch(/at most/);
  });

  test('firstInvalidRecapControlId walks Title → Played on → Recap', () => {
    const ids = newRecapFieldIds();
    expect(firstInvalidRecapControlId({ title: 'bad', playedAt: 'bad', recap: 'bad' }, ids)).toBe(
      ids.title.controlId,
    );
    expect(firstInvalidRecapControlId({ playedAt: 'bad', recap: 'bad' }, ids)).toBe(ids.playedAt.controlId);
    expect(firstInvalidRecapControlId({ recap: 'bad' }, ids)).toBe(ids.recap.controlId);
    expect(firstInvalidRecapControlId({}, ids)).toBeNull();
  });

  test('recapDescribedBy joins help, field error, and form error ids', () => {
    const ids = newRecapFieldIds().title;
    expect(recapDescribedBy(ids)).toBe(ids.helpId);
    expect(recapDescribedBy(ids, { error: true })).toBe(`${ids.helpId} ${ids.errorId}`);
    expect(recapDescribedBy(ids, { error: true, formErrorId: 'new-recap-form-error' })).toBe(
      `${ids.helpId} ${ids.errorId} new-recap-form-error`,
    );
    expect(recapDescribedBy(ids, { help: false })).toBeUndefined();
  });
});
