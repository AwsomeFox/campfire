import { expect, test } from '@playwright/test';
import type { Note } from '@campfire/schema';
import { buildNoteBodiesMap, resolveSweepItemBody } from '../../src/features/notes/inboxSweepLookup';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    campaignId: 7,
    authorUserId: '42',
    authorName: 'Pat',
    kind: 'inbox',
    visibility: 'dm_shared',
    entityType: null,
    entityId: null,
    entityName: null,
    recipientUserId: null,
    recipientName: null,
    body: 'Test note body',
    resolved: false,
    resolvedNote: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

test.describe('inbox sweep title / body lookup (issue #1718)', () => {
  test('uses server-provided item.body first, ignoring client page limits', () => {
    const item = { noteId: 75, body: 'Real title for item 75 beyond initial 50' };
    const itemBodies = { 1: 'Item 1' };
    const knownNotes = { 1: 'Item 1' };

    expect(resolveSweepItemBody(item, itemBodies, knownNotes)).toBe(
      'Real title for item 75 beyond initial 50',
    );
  });

  test('falls back to itemBodies snapshot when item.body is missing or empty', () => {
    const itemWithoutBody = { noteId: 10 };
    const itemWithEmptyBody = { noteId: 10, body: '   ' };
    const itemBodies = { 10: 'Snapshot title 10' };

    expect(resolveSweepItemBody(itemWithoutBody, itemBodies)).toBe('Snapshot title 10');
    expect(resolveSweepItemBody(itemWithEmptyBody, itemBodies)).toBe('Snapshot title 10');
  });

  test('falls back to knownNotes map when item.body and itemBodies are missing', () => {
    const item = { noteId: 20 };
    const knownNotes = { 20: 'Loaded note 20' };

    expect(resolveSweepItemBody(item, undefined, knownNotes)).toBe('Loaded note 20');
  });

  test('returns undefined when no body is available in item or fallbacks', () => {
    const item = { noteId: 999 };
    expect(resolveSweepItemBody(item, { 1: 'A' }, { 2: 'B' })).toBeUndefined();
  });

  test('buildNoteBodiesMap aggregates bodies across open and history note lists', () => {
    const openNotes = [makeNote({ id: 1, body: 'Open 1' }), makeNote({ id: 55, body: 'Open 55' })];
    const historyNotes = [makeNote({ id: 2, body: 'History 2' })];

    const map = buildNoteBodiesMap(openNotes, historyNotes);
    expect(map).toEqual({
      1: 'Open 1',
      2: 'History 2',
      55: 'Open 55',
    });
  });
});
