/**
 * Rule-search pagination helpers (issue #613).
 *
 * Opaque cursors encode the last row's sort keys so pages are keyset-stable under
 * ties and mid-list insertions (same rank/name → id breaks ties). Modes:
 *   - browse — empty query: lower(name), id
 *   - fts    — ranked FTS: name-match bucket, bm25 rank, id
 *   - like   — LIKE fallback: name-match bucket, name, id
 */
import { BadRequestException } from '@nestjs/common';
import {
  RULE_SEARCH_DEFAULT_LIMIT,
  RULE_SEARCH_MAX_LIMIT,
} from '@campfire/schema';
import { foldForSearch } from '../../common/text-search';

export type BrowseCursor = { v: 1; m: 'browse'; n: string; i: number };
export type FtsCursor = { v: 1; m: 'fts'; b: number; r: number; i: number };
export type LikeCursor = { v: 1; m: 'like'; b: number; n: string; i: number };
export type RuleSearchCursor = BrowseCursor | FtsCursor | LikeCursor;

/** Clamp a requested page size to [1, RULE_SEARCH_MAX_LIMIT], defaulting to 50. */
export function clampRuleSearchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return RULE_SEARCH_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return RULE_SEARCH_DEFAULT_LIMIT;
  return Math.min(n, RULE_SEARCH_MAX_LIMIT);
}

/**
 * Name-match rank bucket (mirrors SQL nameMatchRank in rules.service.ts).
 * 0 exact, 1 prefix, 2 contains, 3 body/summary-only.
 */
export function nameMatchBucket(q: string, name: string): number {
  // Needle folding matches SQL nameMatchRank(); column side uses SQL lower() (ASCII).
  const needle = foldForSearch(q.trim().replace(/[%_]/g, ''));
  if (!needle) return 3;
  const folded = name.toLowerCase();
  if (folded === needle) return 0;
  if (folded.startsWith(needle)) return 1;
  if (folded.includes(needle)) return 2;
  return 3;
}

export function encodeRuleSearchCursor(cursor: RuleSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeRuleSearchCursor(raw: string | undefined, expectedMode: RuleSearchCursor['m']): RuleSearchCursor | undefined {
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
    throw new BadRequestException('`cursor` is invalid or does not match this search');
  }
  if (c.m === 'browse') {
    if (typeof c.n !== 'string') throw new BadRequestException('`cursor` is invalid');
    return { v: 1, m: 'browse', n: c.n, i: c.i };
  }
  if (c.m === 'fts') {
    if (typeof c.b !== 'number' || !Number.isInteger(c.b) || typeof c.r !== 'number' || !Number.isFinite(c.r)) {
      throw new BadRequestException('`cursor` is invalid');
    }
    return { v: 1, m: 'fts', b: c.b, r: c.r, i: c.i };
  }
  if (typeof c.b !== 'number' || !Number.isInteger(c.b) || typeof c.n !== 'string') {
    throw new BadRequestException('`cursor` is invalid');
  }
  return { v: 1, m: 'like', b: c.b, n: c.n, i: c.i };
}
