import { expect, test } from '@playwright/test';
import {
  derivePendingLabel,
  resolveBusyConfirmLabel,
} from '../../src/components/confirmDialogLabel';

/**
 * Issue #793 — ConfirmDialog must keep action-specific pending labels instead of
 * overriding every busy state with generic "Working…".
 *
 * Label resolution is a pure helper so RunSessionPage's four confirm actions
 * (and the grammatical fallback for other callers) can be pinned without a
 * browser. The companion Playwright spec holds slow network requests to assert
 * the rendered busy label, aria-busy, and one-shot live announcement.
 */
test.describe('confirm dialog pending labels (issue #793)', () => {
  test.describe('RunSessionPage actions — explicit pendingLabel wins', () => {
    test('End encounter → Ending encounter…', () => {
      expect(resolveBusyConfirmLabel('End encounter', 'Ending encounter…')).toBe('Ending encounter…');
    });

    test('Reopen encounter → Reopening encounter…', () => {
      expect(resolveBusyConfirmLabel('Reopen encounter', 'Reopening encounter…')).toBe(
        'Reopening encounter…',
      );
    });

    test('Delete encounter → Deleting encounter…', () => {
      expect(resolveBusyConfirmLabel('Delete encounter', 'Deleting encounter…')).toBe(
        'Deleting encounter…',
      );
    });

    test('Remove → Removing…', () => {
      expect(resolveBusyConfirmLabel('Remove', 'Removing…')).toBe('Removing…');
    });
  });

  test.describe('grammatical derivation preserves action + object', () => {
    test('End encounter → Ending encounter…', () => {
      expect(derivePendingLabel('End encounter')).toBe('Ending encounter…');
    });

    test('Reopen encounter → Reopening encounter…', () => {
      expect(derivePendingLabel('Reopen encounter')).toBe('Reopening encounter…');
    });

    test('Delete encounter → Deleting encounter…', () => {
      expect(derivePendingLabel('Delete encounter')).toBe('Deleting encounter…');
    });

    test('Remove → Removing…', () => {
      expect(derivePendingLabel('Remove')).toBe('Removing…');
    });

    test('Delete NPC → Deleting NPC…', () => {
      expect(derivePendingLabel('Delete NPC')).toBe('Deleting NPC…');
    });

    test('Cancel session → Cancelling session…', () => {
      expect(derivePendingLabel('Cancel session')).toBe('Cancelling session…');
    });

    test('Move to Trash → Moving to Trash…', () => {
      expect(derivePendingLabel('Move to Trash')).toBe('Moving to Trash…');
    });

    test('already-progressive labels are left alone', () => {
      expect(derivePendingLabel('Deleting…')).toBe('Deleting…');
      expect(derivePendingLabel('Working...')).toBe('Working…');
    });

    test('empty label falls back to Working…', () => {
      expect(derivePendingLabel('')).toBe('Working…');
      expect(derivePendingLabel('   ')).toBe('Working…');
    });
  });

  test('resolveBusyConfirmLabel prefers explicit pendingLabel over derivation', () => {
    expect(resolveBusyConfirmLabel('End encounter', 'Wrapping up…')).toBe('Wrapping up…');
    expect(resolveBusyConfirmLabel('End encounter')).toBe('Ending encounter…');
    expect(resolveBusyConfirmLabel('End encounter', '')).toBe('Ending encounter…');
  });
});
