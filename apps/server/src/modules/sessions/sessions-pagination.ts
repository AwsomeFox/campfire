import { SESSIONS_LIST_DEFAULT_LIMIT, SESSIONS_LIST_MAX_LIMIT } from '@campfire/schema';

export function clampSessionsListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSIONS_LIST_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return SESSIONS_LIST_DEFAULT_LIMIT;
  return Math.min(n, SESSIONS_LIST_MAX_LIMIT);
}

export function sessionsListOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const n = Math.floor(offset);
  return n < 0 ? 0 : n;
}
