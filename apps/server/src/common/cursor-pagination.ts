import { BadRequestException } from '@nestjs/common';

/**
 * Shared cursor-pagination helpers (issue #615).
 *
 * Opaque cursors encode JSON sort keys as base64url. Domain modules define their
 * own cursor shapes and validation; these utilities handle encoding, limit
 * clamping, and the standard `{ items, total, hasMore, nextCursor, limit }`
 * envelope used by notes (#608), timeline (#615), and future high-traffic lists.
 */

/** Encode an opaque cursor payload as base64url JSON. */
export function encodeCursor<T extends object>(cursor: T): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode a raw cursor string; throws BadRequestException on malformed input. */
export function decodeCursorRaw(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('`cursor` is invalid');
  }
}

/** Clamp a requested page size to [1, maxLimit], defaulting to defaultLimit. */
export function clampListLimit(
  limit: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return defaultLimit;
  const n = Math.floor(limit);
  if (n < 1) return defaultLimit;
  return Math.min(n, maxLimit);
}

export type CursorListPageResult<T> = {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
};

/**
 * Build a cursor-paginated list envelope from a `limit + 1` probe slice.
 * `lastRowToCursor` receives the last *returned* row (not the probe row).
 */
export function buildCursorListPage<T>(
  rows: T[],
  limit: number,
  total: number,
  lastRowToCursor: (last: T) => object,
): CursorListPageResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(lastRowToCursor(last)) : null;
  return { items, total, hasMore, nextCursor, limit };
}
