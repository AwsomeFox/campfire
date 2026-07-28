import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initialSaveFeedback, reduceSaveFeedback } from '../../src/components/saveFeedbackState';
import { formatSaveFailure } from '../../src/components/SaveFeedback';

test.describe('shared save feedback (issue #756)', () => {
  test('covers slow save, duplicate guard state, failure, retry, and durable saved time', () => {
    const dirty = reduceSaveFeedback(initialSaveFeedback, { type: 'edit' });
    const saving = reduceSaveFeedback(dirty, { type: 'begin' });
    expect(saving.state).toBe('saving');
    // A second begin has no different terminal result; UI controls disable while this state is active.
    expect(reduceSaveFeedback(saving, { type: 'begin' }).state).toBe('saving');
    const failed = reduceSaveFeedback(saving, { type: 'fail', error: 'offline' });
    expect(failed).toMatchObject({ state: 'error', error: 'offline' });
    expect(reduceSaveFeedback(saving, { type: 'fail', error: "Couldn't save changes.", generic: true })).toMatchObject({
      state: 'error',
      error: "Couldn't save changes.",
      genericError: true,
    });
    const retried = reduceSaveFeedback(failed, { type: 'begin' });
    const at = new Date('2026-07-28T14:30:00.000Z');
    const saved = reduceSaveFeedback(retried, { type: 'succeed', at });
    expect(saved).toMatchObject({ state: 'saved', savedAt: at });
    // Renders/reducers that do not receive an edit preserve the actual save timestamp.
    expect(reduceSaveFeedback(saved, { type: 'succeed', at }).savedAt).toBe(at);
    expect(reduceSaveFeedback(saved, { type: 'edit' })).toMatchObject({ state: 'dirty', savedAt: null });
    // Reverting to the baseline after a failure clears the stale error instead of
    // claiming unsaved edits remain.
    expect(reduceSaveFeedback(failed, { type: 'reset' })).toEqual(initialSaveFeedback);
  });
});

test('error copy identifies the subject without duplicating save failure phrasing', () => {
  expect(formatSaveFailure('Campaign details', "Couldn't save changes.")).toBe(
    'Save failed for Campaign details. Your edits are still here; try again.',
  );
  expect(formatSaveFailure('Server AI provider', "Couldn't save the provider.")).toBe(
    'Save failed for Server AI provider. Your edits are still here; try again.',
  );
  expect(formatSaveFailure('Campaign details', 'Campaign name is required.')).toBe(
    'Save failed for Campaign details. Campaign name is required. Your edits are still here; try again.',
  );
});

// Issue #756 review (Devin): the generic-fallback regex used to be greedy across sentence
// boundaries, so a multi-sentence server error starting with "Couldn't save ..." collapsed
// to the generic message and silently dropped the actionable detail after the first period.
test('a multi-sentence server error starting like the generic fallback keeps its actionable detail', () => {
  expect(formatSaveFailure('Server AI provider', "Couldn't save the provider. Check your API key.")).toBe(
    "Save failed for Server AI provider. Couldn't save the provider. Check your API key. Your edits are still here; try again.",
  );
});

test('error copy can be supplied by localized catalog formatters', () => {
  const copy = {
    generic: (subject: string) => `GENERIC ${subject}`,
    withDetail: (subject: string, error: string) => `DETAIL ${subject}: ${error}`,
  };
  expect(formatSaveFailure('AI budget', "Couldn't save the budget.", copy)).toBe('GENERIC AI budget');
  expect(formatSaveFailure('AI budget', 'Enter a non-negative number.', copy)).toBe(
    'DETAIL AI budget: Enter a non-negative number',
  );
  expect(formatSaveFailure('AI budget', 'Localized generic fallback.', copy, true)).toBe('GENERIC AI budget');
});

test('every migrated editor associates its editable controls with shared save feedback', () => {
  const root = resolve(__dirname, '../../src/features');
  for (const relative of [
    'dashboard/StatusHeader.tsx',
    'settings/CampaignSettingsPage.tsx',
    'settings/ProviderForm.tsx',
    'settings/AiDmCard.tsx',
    'admin/AiConsoleCard.tsx',
  ]) {
    expect(readFileSync(resolve(root, relative), 'utf8'), relative).toContain('feedback.statusId');
  }
});
