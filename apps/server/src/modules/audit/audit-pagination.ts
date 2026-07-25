/**
 * Campaign audit list pagination helpers (issue #443).
 *
 * Newest-first by autoincrement id. Opaque cursors encode the last row's id so pages
 * are keyset-stable under concurrent inserts.
 */
import { BadRequestException } from '@nestjs/common';
import { AUDIT_LIST_DEFAULT_LIMIT, AUDIT_LIST_MAX_LIMIT } from '@campfire/schema';
import { clampListLimit, decodeCursorRaw, encodeCursor } from '../../common/cursor-pagination';

export type AuditIdCursor = { v: 1; m: 'id'; i: number };

/** Clamp a requested page size to [1, AUDIT_LIST_MAX_LIMIT], defaulting to 50. */
export function clampAuditListLimit(limit?: number): number {
  return clampListLimit(limit, AUDIT_LIST_DEFAULT_LIMIT, AUDIT_LIST_MAX_LIMIT);
}

export function encodeAuditCursor(cursor: AuditIdCursor): string {
  return encodeCursor(cursor);
}

export function decodeAuditCursor(raw: string | undefined): AuditIdCursor | undefined {
  const parsed = decodeCursorRaw(raw);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException('`cursor` is invalid');
  }
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1 || c.m !== 'id' || typeof c.i !== 'number' || !Number.isInteger(c.i) || c.i < 1) {
    throw new BadRequestException('`cursor` is invalid or does not match this list');
  }
  return { v: 1, m: 'id', i: c.i };
}
