import { ConflictException } from '@nestjs/common';

/** Stable token returned by singleton editors before their first row exists. */
export const MISSING_REVISION = '1970-01-01T00:00:00.000Z';

/**
 * `updatedAt` is the public revision token. Guarantee that a successful write
 * changes it even when two writes happen inside the same millisecond.
 */
export function nextUpdatedAt(current: string): string {
  const now = Date.now();
  const previous = Date.parse(current);
  return new Date(Number.isFinite(previous) && previous >= now ? previous + 1 : now).toISOString();
}

/** The shared, machine-readable stale-write response used by HTTP and MCP. */
export function staleWrite(expectedUpdatedAt: string | undefined, currentUpdatedAt: string): ConflictException {
  return new ConflictException({
    code: 'STALE_WRITE',
    message:
      'This was changed by someone else since you loaded it. Your draft was not saved; review the latest fields and retry.',
    expectedUpdatedAt,
    currentUpdatedAt,
  });
}
