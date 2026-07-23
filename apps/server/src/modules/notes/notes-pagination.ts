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

export type NotesIdCursor = { v: 1; m: 'id'; i: number };
export type NotesUpdatedCursor = { v: 1; m: 'updated'; u: string; i: number };
export type NotesCursor = NotesIdCursor | NotesUpdatedCursor;

/** Clamp a requested page size to [1, NOTES_LIST_MAX_LIMIT], defaulting to 50. */
export function clampNotesListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return NOTES_LIST_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return NOTES_LIST_DEFAULT_LIMIT;
  return Math.min(n, NOTES_LIST_MAX_LIMIT);
}

export function encodeNotesCursor(cursor: NotesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeNotesCursor(raw: string | undefined, expectedMode: NotesCursor['m']): NotesCursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('`cursor` is invalid');
  }
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
  if (typeof c.u !== 'string' || c.u.length === 0) {
    throw new BadRequestException('`cursor` is invalid');
  }
  return { v: 1, m: 'updated', u: c.u, i: c.i };
}
