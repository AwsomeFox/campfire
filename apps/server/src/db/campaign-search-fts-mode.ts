import { Logger } from '@nestjs/common';

/**
 * Campaign search boot-mode diagnostics (issue #1481).
 *
 * Kept in its own module (rather than inline in db.module.ts) so a unit test can
 * exercise the "FTS unavailable" warning without importing better-sqlite3 /
 * drizzle / the whole DB module: a real test database bundles the fts5 extension,
 * so the unavailable branch can't be triggered end-to-end.
 */
const log = new Logger('Database');

/**
 * Single, canonical startup warning when campaign search can't use its FTS5
 * index. Previously the only signal was a terse catch-handler message that could
 * read as a transient setup error rather than "this install is permanently on the
 * slower full-scan path", and nothing reported the active mode at all. The
 * message names the mode, the consequence, and where to read it (/me) so a
 * silently-degraded deployment is diagnosable.
 */
export function warnCampaignSearchFtsUnavailable(available: boolean, detail?: string): void {
  if (available) return;
  log.warn(
    `Campaign search is running in fallback (full-scan) mode: the SQLite FTS5 extension is unavailable${detail ? ` (${detail})` : ''}, so every search scans each collection instead of using the index. Results are unchanged but latency grows with campaign size. Rebuild SQLite with FTS5 to restore the index; the active mode is reported on /me as instance.searchMode.`,
  );
}
