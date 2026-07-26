/**
 * Moderation queue pagination helpers (issue #601).
 *
 * Newest-first by autoincrement id, exactly like the campaign audit list (#443) —
 * an incident queue and an audit trail have the same access pattern (page back
 * through history, stable under concurrent inserts), so they share the cursor
 * shape rather than inventing a second one.
 */
import { BadRequestException } from '@nestjs/common';
import { MODERATION_LIST_DEFAULT_LIMIT, MODERATION_LIST_MAX_LIMIT } from '@campfire/schema';
import { clampListLimit, decodeCursorRaw, encodeCursor } from '../../common/cursor-pagination';

export type ModerationIdCursor = { v: 1; m: 'id'; i: number };

/** Clamp a requested page size to [1, MODERATION_LIST_MAX_LIMIT]. */
export function clampModerationListLimit(limit?: number): number {
  return clampListLimit(limit, MODERATION_LIST_DEFAULT_LIMIT, MODERATION_LIST_MAX_LIMIT);
}

export function encodeModerationCursor(cursor: ModerationIdCursor): string {
  return encodeCursor(cursor);
}

export function decodeModerationCursor(raw: string | undefined): ModerationIdCursor | undefined {
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

/** Parse a raw `?limit=` query value; undefined when absent so the clamp default applies. */
export function parseModerationLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadRequestException('`limit` must be a number');
  return n;
}
