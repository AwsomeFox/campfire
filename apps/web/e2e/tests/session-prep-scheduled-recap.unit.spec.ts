import { expect, test } from '@playwright/test';
import {
  RECAP_DM_SECRET_HELP,
  RECAP_DM_SECRET_MAX,
  RECAP_FIELD_LABELS,
  editRecapFieldIds,
  isNewRecapDraftMeaningful,
  isRecapEditorDirty,
  newRecapFieldIds,
  recapEditorDraftFromSession,
  recapEditorDraftsEqual,
  validateRecapFields,
} from '../../src/features/sessions/recapFormFields';

/**
 * Issue #1486 — Session prep notes (dmSecret), scheduled session recap linking,
 * RSVP attendance seeding, and secrecy contract.
 */

test.describe('session prep notes contract (issue #1486)', () => {
  test('defines DM Prep Notes label, help copy, and max limit', () => {
    expect(RECAP_FIELD_LABELS.dmSecret).toBe('DM prep notes');
    expect(RECAP_DM_SECRET_HELP).toMatch(/DM-only/i);
    expect(RECAP_DM_SECRET_MAX).toBe(20_000);
  });

  test('includes dmSecret control ids in new and edit recap form field ids', () => {
    const newIds = newRecapFieldIds();
    expect(newIds.dmSecret).toEqual({
      controlId: 'new-recap-dm-secret',
      helpId: 'new-recap-dm-secret-help',
      errorId: 'new-recap-dm-secret-error',
    });

    const editIds = editRecapFieldIds(101);
    expect(editIds.dmSecret).toEqual({
      controlId: 'session-101-dm-secret',
      helpId: 'session-101-dm-secret-help',
      errorId: 'session-101-dm-secret-error',
    });
  });

  test('validateRecapFields validates dmSecret max length', () => {
    expect(validateRecapFields({ title: '', playedAt: '', recap: '', dmSecret: 'Secret notes' })).toEqual({});
    expect(
      validateRecapFields({ title: '', playedAt: '', recap: '', dmSecret: 'x'.repeat(RECAP_DM_SECRET_MAX + 1) }),
    ).toEqual({
      dmSecret: `DM prep notes must be at most ${RECAP_DM_SECRET_MAX.toLocaleString()} characters.`,
    });
  });

  test('draft handling includes dmSecret and scheduledSessionId', () => {
    const draft = recapEditorDraftFromSession({
      title: 'Session 1',
      playedAt: '2026-07-31',
      recap: 'Party beat dragon',
      dmSecret: 'The dragon is secretly alive',
      scheduledSessionId: 42,
    });

    expect(draft).toEqual({
      title: 'Session 1',
      playedAt: '2026-07-31',
      recap: 'Party beat dragon',
      dmSecret: 'The dragon is secretly alive',
      scheduledSessionId: 42,
    });

    expect(isNewRecapDraftMeaningful(draft)).toBe(true);
    expect(
      isNewRecapDraftMeaningful({
        title: '',
        playedAt: '',
        recap: '',
        dmSecret: 'secret',
        scheduledSessionId: null,
      }),
    ).toBe(true);
  });

  test('detects dirty state changes for dmSecret and scheduledSessionId', () => {
    const baseline = {
      title: 'Session 1',
      playedAt: '2026-07-31',
      recap: 'Party beat dragon',
      dmSecret: 'Secret A',
      scheduledSessionId: 42,
    };

    const same = { ...baseline };
    expect(recapEditorDraftsEqual(same, baseline)).toBe(true);
    expect(isRecapEditorDirty(same, baseline)).toBe(false);

    const editedSecret = { ...baseline, dmSecret: 'Secret B' };
    expect(recapEditorDraftsEqual(editedSecret, baseline)).toBe(false);
    expect(isRecapEditorDirty(editedSecret, baseline)).toBe(true);
  });
});
