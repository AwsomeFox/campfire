/**
 * Discussion thread pagination helpers (issue #609).
 *
 * Opaque cursors encode the last row's sort key so pages are keyset-stable.
 * Modes:
 *   - root  — oldest-first root threads by autoincrement id
 *   - reply — oldest-first replies under one root (cursor also carries rootId)
 */
import { BadRequestException } from '@nestjs/common';
import {
  COMMENTS_REPLY_MAX_LIMIT,
  COMMENTS_REPLY_PREVIEW_LIMIT,
  COMMENTS_THREAD_DEFAULT_LIMIT,
  COMMENTS_THREAD_MAX_LIMIT,
} from '@campfire/schema';

export type CommentsRootCursor = { v: 1; m: 'root'; i: number };
export type CommentsReplyCursor = { v: 1; m: 'reply'; r: number; i: number };
export type CommentsCursor = CommentsRootCursor | CommentsReplyCursor;

export function clampCommentsThreadLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return COMMENTS_THREAD_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return COMMENTS_THREAD_DEFAULT_LIMIT;
  return Math.min(n, COMMENTS_THREAD_MAX_LIMIT);
}

export function clampCommentsReplyLimit(limit?: number, preview = false): number {
  const fallback = preview ? COMMENTS_REPLY_PREVIEW_LIMIT : COMMENTS_REPLY_MAX_LIMIT;
  const max = preview ? COMMENTS_REPLY_PREVIEW_LIMIT : COMMENTS_REPLY_MAX_LIMIT;
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const n = Math.floor(limit);
  if (n < 1) return fallback;
  return Math.min(n, max);
}

export function encodeCommentsCursor(cursor: CommentsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCommentsRootCursor(raw: string | undefined): CommentsRootCursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  const c = decodeCommentsCursorRaw(raw);
  if (c.m !== 'root' || typeof c.i !== 'number' || !Number.isInteger(c.i) || c.i < 1) {
    throw new BadRequestException('`cursor` is invalid or does not match this list');
  }
  return { v: 1, m: 'root', i: c.i };
}

export function decodeCommentsReplyCursor(
  raw: string | undefined,
  rootId: number,
): CommentsReplyCursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  const c = decodeCommentsCursorRaw(raw);
  if (
    c.m !== 'reply' ||
    c.r !== rootId ||
    typeof c.i !== 'number' ||
    !Number.isInteger(c.i) ||
    c.i < 1
  ) {
    throw new BadRequestException('`cursor` is invalid or does not match this reply list');
  }
  return { v: 1, m: 'reply', r: rootId, i: c.i };
}

function decodeCommentsCursorRaw(raw: string): Record<string, unknown> {
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
  if (c.v !== 1 || (c.m !== 'root' && c.m !== 'reply')) {
    throw new BadRequestException('`cursor` is invalid');
  }
  return c;
}

export function parseCommentsLimit(raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequestException('`limit` must be a positive integer');
  }
  return limit;
}
