/**
 * Timeline list pagination helpers (issue #615).
 *
 * Opaque cursors encode the last row's sort keys so pages are keyset-stable under
 * mid-list reordering. Mode:
 *   - sort — narrative order by sortIndex ASC, id ASC
 */
import { BadRequestException } from '@nestjs/common';
import { TIMELINE_LIST_DEFAULT_LIMIT, TIMELINE_LIST_MAX_LIMIT } from '@campfire/schema';
import { clampListLimit, decodeCursorRaw, encodeCursor } from '../../common/cursor-pagination';

export type TimelineSortCursor = { v: 1; m: 'sort'; s: number; i: number };

/** Clamp a requested page size to [1, TIMELINE_LIST_MAX_LIMIT], defaulting to 50. */
export function clampTimelineListLimit(limit?: number): number {
  return clampListLimit(limit, TIMELINE_LIST_DEFAULT_LIMIT, TIMELINE_LIST_MAX_LIMIT);
}

export function encodeTimelineCursor(cursor: TimelineSortCursor): string {
  return encodeCursor(cursor);
}

export function decodeTimelineCursor(raw: string | undefined): TimelineSortCursor | undefined {
  const parsed = decodeCursorRaw(raw);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException('`cursor` is invalid');
  }
  const c = parsed as Record<string, unknown>;
  if (
    c.v !== 1 ||
    c.m !== 'sort' ||
    typeof c.s !== 'number' ||
    !Number.isInteger(c.s) ||
    typeof c.i !== 'number' ||
    !Number.isInteger(c.i) ||
    c.i < 1
  ) {
    throw new BadRequestException('`cursor` is invalid or does not match this list');
  }
  return { v: 1, m: 'sort', s: c.s, i: c.i };
}
