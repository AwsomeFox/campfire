import { BadRequestException } from '@nestjs/common';
import type { PageParams } from '@campfire/schema';

/**
 * Shared list-pagination convention (issue #71).
 *
 * Controllers receive `limit`/`offset` as raw query strings; this parses and
 * validates them into a typed {@link PageParams}, capping `limit` at a
 * per-endpoint `maxLimit`. Both are optional: an absent `limit` returns
 * `undefined` (the service then applies no SQL LIMIT, or its historical default),
 * so pagination is opt-in and existing callers are unaffected.
 *
 * Invalid input (non-numeric, negative, zero limit, fractional) is a 400 rather
 * than being silently coerced — a mistyped `?limit=abc` should fail loudly.
 */
export function parsePageParams(
  raw: { limit?: string; offset?: string },
  maxLimit: number,
): PageParams {
  const out: PageParams = {};

  if (raw.limit !== undefined && raw.limit !== '') {
    const limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BadRequestException('`limit` must be a positive integer');
    }
    out.limit = Math.min(limit, maxLimit);
  }

  if (raw.offset !== undefined && raw.offset !== '') {
    const offset = Number(raw.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('`offset` must be a non-negative integer');
    }
    out.offset = offset;
  }

  return out;
}

// SQLite requires a LIMIT clause whenever OFFSET is present. For an offset-only
// page we therefore emit a very large LIMIT (effectively unbounded — no real
// list approaches this many rows) rather than SQLite's `LIMIT -1` sentinel, which
// the Drizzle builder does not render.
const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Push `limit`/`offset` into a Drizzle `.$dynamic()` query builder. No-op when
 * neither is set (the query returns every row). Structurally typed so it works
 * with any dynamic query builder.
 */
export function applyPage<Q extends { limit: (n: number) => Q; offset: (n: number) => Q }>(
  query: Q,
  page?: PageParams,
): Q {
  if (page?.limit === undefined && page?.offset === undefined) return query;
  let q = query.limit(page.limit ?? UNBOUNDED_LIMIT);
  if (page.offset !== undefined) q = q.offset(page.offset);
  return q;
}
