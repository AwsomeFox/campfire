/**
 * Form draft storage and shape validation (issue #1986) unit test suite.
 */
import { expect, test } from '@playwright/test';
import { normalizeDraft, buildFormDraftEnvelope, readFormDraft, isFormDraftStale } from '../../src/lib/formDraftStorage';

test.describe('normalizeDraft (issue #1986)', () => {
  test('fills missing top-level fields from baseline for non-character-sheet forms', () => {
    // Non-character-sheet consumer 1: Session Zero Charter draft
    type CharterDraft = {
      theme: string;
      boundaries: string;
      safetyTools: string;
      newField: string;
    };

    const baseline: CharterDraft = {
      theme: '',
      boundaries: '',
      safetyTools: '',
      newField: 'default-value',
    };

    // Draft saved BEFORE newField was added
    const legacyStored = {
      theme: 'Dark Fantasy',
      boundaries: 'No PVP',
      safetyTools: 'Lines & Veils',
      // newField is missing
    };

    const normalized = normalizeDraft<CharterDraft>(legacyStored, baseline);

    expect(normalized.theme).toBe('Dark Fantasy');
    expect(normalized.boundaries).toBe('No PVP');
    expect(normalized.safetyTools).toBe('Lines & Veils');
    expect(normalized.newField).toBe('default-value');
    expect(normalized.newField).not.toBeUndefined();
  });

  test('fills missing top-level fields from baseline for session recap drafts', () => {
    // Non-character-sheet consumer 2: Session Recap draft
    type RecapDraft = {
      title: string;
      playedAt: string;
      recap: string;
      dmSecret?: string;
      locationTag?: string;
    };

    const baseline: RecapDraft = {
      title: 'Session 1',
      playedAt: '2026-08-01',
      recap: 'Fought goblins.',
      dmSecret: '',
      locationTag: 'Phandalin',
    };

    const legacyStored = {
      title: 'Session 1 (WIP)',
      playedAt: '2026-08-01',
      recap: 'Fought goblins and escaped.',
      // dmSecret and locationTag are missing
    };

    const normalized = normalizeDraft<RecapDraft>(legacyStored, baseline);

    expect(normalized.title).toBe('Session 1 (WIP)');
    expect(normalized.recap).toBe('Fought goblins and escaped.');
    expect(normalized.dmSecret).toBe('');
    expect(normalized.locationTag).toBe('Phandalin');
    expect(normalized.locationTag).not.toBeUndefined();
  });

  test('handles nested object properties gracefully (e.g., stats or config objects)', () => {
    type CharacterDraft = {
      name: string;
      speed: string;
      stats: Record<string, string>;
    };

    const baseline: CharacterDraft = {
      name: 'Hero',
      speed: '30 ft',
      stats: { str: '10', dex: '10', con: '10' },
    };

    const legacyStored = {
      name: 'Hero WIP',
      // speed is missing
      stats: { str: '16' }, // dex and con are missing
    };

    const normalized = normalizeDraft<CharacterDraft>(legacyStored, baseline);

    expect(normalized.name).toBe('Hero WIP');
    expect(normalized.speed).toBe('30 ft');
    expect(normalized.stats).toEqual({ str: '16', dex: '10', con: '10' });
  });

  test('suppresses false restore prompt when legacy stored draft equals baseline after normalization', () => {
    type FormDraft = {
      title: string;
      notes: string;
      addedField: string;
    };

    const baseline: FormDraft = {
      title: '',
      notes: '',
      addedField: 'default',
    };

    // User made no edits, but saved before addedField existed
    const legacyUneditedStored = {
      title: '',
      notes: '',
    };

    const normalized = normalizeDraft<FormDraft>(legacyUneditedStored, baseline);

    // Deep equality check between normalized draft and baseline
    const isEqual = JSON.stringify(normalized) === JSON.stringify(baseline);
    expect(isEqual).toBe(true);
  });
});
