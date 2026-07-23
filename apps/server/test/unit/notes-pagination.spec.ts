import {
  clampNotesListLimit,
  decodeNotesCursor,
  encodeNotesCursor,
} from '../../src/modules/notes/notes-pagination';

describe('notes-pagination helpers (issue #608)', () => {
  it('clamps page size to default 50 and max 200', () => {
    expect(clampNotesListLimit(undefined)).toBe(50);
    expect(clampNotesListLimit(1)).toBe(1);
    expect(clampNotesListLimit(5)).toBe(5);
    expect(clampNotesListLimit(200)).toBe(200);
    expect(clampNotesListLimit(500)).toBe(200);
    expect(clampNotesListLimit(0)).toBe(50);
    expect(clampNotesListLimit(-3)).toBe(50);
  });

  it('round-trips id and updated cursors and rejects mismatched modes', () => {
    const idCursor = encodeNotesCursor({ v: 1, m: 'id', i: 42 });
    expect(decodeNotesCursor(idCursor, 'id')).toEqual({ v: 1, m: 'id', i: 42 });
    expect(() => decodeNotesCursor(idCursor, 'updated')).toThrow(/cursor/i);

    const updated = encodeNotesCursor({
      v: 1,
      m: 'updated',
      u: '2026-07-23T12:00:00.000Z',
      i: 7,
    });
    expect(decodeNotesCursor(updated, 'updated')).toEqual({
      v: 1,
      m: 'updated',
      u: '2026-07-23T12:00:00.000Z',
      i: 7,
    });

    expect(decodeNotesCursor(undefined, 'id')).toBeUndefined();
    expect(() => decodeNotesCursor('%%%not-base64%%%', 'id')).toThrow(/cursor/i);
  });
});
