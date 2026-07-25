/**
 * Notes / inbox list pagination helpers (issue #608).
 *
 * Opaque cursors encode the last row's sort keys so pages are keyset-stable under
 * mid-list insertions. Modes:
 *   - id      — newest-first by autoincrement id (notes + open inbox)
 *   - updated — newest-resolution-first by updatedAt, id (resolved inbox history)
 */
import { BadRequestException } from '@nestjs/common';
import { NOTES_LIST_DEFAULT_LIMIT, NOTES_LIST_MAX_LIMIT } from '@campfire/schema';
import { clampListLimit, decodeCursorRaw, encodeCursor } from '../../common/cursor-pagination';

export type NotesIdCursor = { v: 1; m: 'id'; i: number };
export type NotesUpdatedCursor = { v: 1; m: 'updated'; u: string; i: number };
export type NotesCursor = NotesIdCursor | NotesUpdatedCursor;

/** Clamp a requested page size to [1, NOTES_LIST_MAX_LIMIT], defaulting to 50. */
export function clampNotesListLimit(limit?: number): number {
  return clampListLimit(limit, NOTES_LIST_DEFAULT_LIMIT, NOTES_LIST_MAX_LIMIT);
}

export function encodeNotesCursor(cursor: NotesCursor): string {
  return encodeCursor(cursor);
}

export function decodeNotesCursor(raw: string | undefined, expectedMode: NotesCursor['m']): NotesCursor | undefined {
  const parsed = decodeCursorRaw(raw);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException('`cursor` is invalid');
  }
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1 || c.m !== expectedMode || typeof c.i !== 'number' || !Number.isInteger(c.i) || c.i < 1) {
    throw new BadRequestException('`cursor` is invalid or does not match this list');
  }
  if (c.m === 'id') {
    return { v: 1, m: 'id', i: c.i };
  }
  // `u` is the updatedAt keyset value — require Campfire's ISO-8601 shape (nowIso()), else a
  // crafted/lenient Date.parse string would keyset-compare wrongly and silently corrupt paging.
  if (
    typeof c.u !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(c.u) ||
    Number.isNaN(Date.parse(c.u))
  ) {
    throw new BadRequestException('`cursor` is invalid');
  }
  return { v: 1, m: 'updated', u: c.u, i: c.i };
}
