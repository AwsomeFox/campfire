import { expect, test } from '@playwright/test';
import type { Note } from '@campfire/schema';
import {
  audienceExpandedOrChanged,
  buildNoteUpdatePayload,
  compareNoteConflict,
  deriveNoteSaveStatus,
  draftFromNote,
  isNoteEditDirty,
  noteEditCanSave,
  noteSaveStatusLabel,
} from '../../src/features/notes/noteEditState';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    campaignId: 7,
    authorUserId: '42',
    authorName: 'Pat',
    kind: 'note',
    visibility: 'private',
    entityType: null,
    entityId: null,
    entityName: null,
    recipientUserId: null,
    recipientName: null,
    body: 'Secret about the relic',
    resolved: false,
    resolvedNote: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Issue #784 — My Notes author editing: dirty detection, expectedUpdatedAt payload,
 * conflict compare, and notify-only-on-audience-change parity with the server.
 */
test.describe('note edit state (issue #784)', () => {
  test('draftFromNote captures body, audience, anchor, and updatedAt', () => {
    const baseline = draftFromNote(
      note({
        visibility: 'whisper',
        recipientUserId: '99',
        entityType: 'quest',
        entityId: 3,
        entityName: 'Vault',
      }),
    );
    expect(baseline.body).toBe('Secret about the relic');
    expect(baseline.visibility).toBe('whisper');
    expect(baseline.recipientUserId).toBe('99');
    expect(baseline.attach).toEqual({ entityType: 'quest', entityId: 3 });
    expect(baseline.updatedAt).toBe('2026-07-01T12:00:00.000Z');
  });

  test('isNoteEditDirty ignores identical drafts and detects body/audience/anchor edits', () => {
    const baseline = draftFromNote(note({ entityType: 'npc', entityId: 2 }));
    expect(isNoteEditDirty(baseline, baseline)).toBe(false);
    expect(isNoteEditDirty({ ...baseline, body: 'typo fix' }, baseline)).toBe(true);
    expect(isNoteEditDirty({ ...baseline, visibility: 'dm_shared' }, baseline)).toBe(true);
    expect(isNoteEditDirty({ ...baseline, attach: { entityType: 'quest', entityId: 9 } }, baseline)).toBe(
      true,
    );
  });

  test('noteEditCanSave rejects empty body and whisper without recipient', () => {
    const baseline = draftFromNote(note());
    expect(noteEditCanSave(baseline)).toBe(true);
    expect(noteEditCanSave({ ...baseline, body: '   ' })).toBe(false);
    expect(noteEditCanSave({ ...baseline, visibility: 'whisper', recipientUserId: '' })).toBe(false);
    expect(noteEditCanSave({ ...baseline, visibility: 'whisper', recipientUserId: '5' })).toBe(true);
  });

  test('buildNoteUpdatePayload trims body, clears recipient off whisper, and sends expectedUpdatedAt', () => {
    const draft = draftFromNote(
      note({
        body: '  keep the rope  ',
        visibility: 'party_shared',
        entityType: 'location',
        entityId: 8,
      }),
    );
    expect(buildNoteUpdatePayload(draft, draft.updatedAt)).toEqual({
      body: 'keep the rope',
      visibility: 'party_shared',
      recipientUserId: null,
      entityType: 'location',
      entityId: 8,
      expectedUpdatedAt: '2026-07-01T12:00:00.000Z',
    });

    const whisper = draftFromNote(
      note({ visibility: 'whisper', recipientUserId: '11', body: 'trap door' }),
    );
    expect(buildNoteUpdatePayload(whisper, whisper.updatedAt).recipientUserId).toBe('11');
  });

  test('audienceExpandedOrChanged matches server notify gates (share/retarget, not typo fixes)', () => {
    expect(
      audienceExpandedOrChanged(
        { visibility: 'private', recipientUserId: '' },
        { visibility: 'private', recipientUserId: '' },
      ),
    ).toBe(false);
    expect(
      audienceExpandedOrChanged(
        { visibility: 'dm_shared', recipientUserId: '' },
        { visibility: 'dm_shared', recipientUserId: '' },
      ),
    ).toBe(false);
    expect(
      audienceExpandedOrChanged(
        { visibility: 'private', recipientUserId: '' },
        { visibility: 'dm_shared', recipientUserId: '' },
      ),
    ).toBe(true);
    expect(
      audienceExpandedOrChanged(
        { visibility: 'private', recipientUserId: '' },
        { visibility: 'party_shared', recipientUserId: '' },
      ),
    ).toBe(true);
    expect(
      audienceExpandedOrChanged(
        { visibility: 'whisper', recipientUserId: '1' },
        { visibility: 'whisper', recipientUserId: '2' },
      ),
    ).toBe(true);
    expect(
      audienceExpandedOrChanged(
        { visibility: 'whisper', recipientUserId: '1' },
        { visibility: 'whisper', recipientUserId: '1' },
      ),
    ).toBe(false);
  });

  test('compareNoteConflict flags body/audience/anchor diffs against the server tip', () => {
    const draft = draftFromNote(note({ body: 'my draft', visibility: 'private' }));
    const cmp = compareNoteConflict(draft, note({ body: 'server tip', visibility: 'dm_shared' }));
    expect(cmp.bodyChanged).toBe(true);
    expect(cmp.audienceChanged).toBe(true);
    expect(cmp.anchorChanged).toBe(false);
    expect(cmp.server.body).toBe('server tip');
  });

  test('deriveNoteSaveStatus / noteSaveStatusLabel cover dirty→saving→saved→conflict→error', () => {
    expect(deriveNoteSaveStatus({ dirty: false, saving: false, saved: false, error: false, conflict: false })).toBe(
      'clean',
    );
    expect(deriveNoteSaveStatus({ dirty: true, saving: false, saved: false, error: false, conflict: false })).toBe(
      'dirty',
    );
    expect(deriveNoteSaveStatus({ dirty: true, saving: true, saved: false, error: false, conflict: false })).toBe(
      'saving',
    );
    expect(deriveNoteSaveStatus({ dirty: false, saving: false, saved: true, error: false, conflict: false })).toBe(
      'saved',
    );
    expect(deriveNoteSaveStatus({ dirty: true, saving: false, saved: false, error: false, conflict: true })).toBe(
      'conflict',
    );
    expect(deriveNoteSaveStatus({ dirty: true, saving: false, saved: false, error: true, conflict: false })).toBe(
      'error',
    );

    expect(noteSaveStatusLabel('dirty')).toMatch(/unsaved/i);
    expect(noteSaveStatusLabel('saving')).toMatch(/saving/i);
    expect(noteSaveStatusLabel('saved')).toBe('Saved');
    expect(noteSaveStatusLabel('conflict')).toMatch(/conflict/i);
    expect(noteSaveStatusLabel('clean')).toBe('');
  });
});
