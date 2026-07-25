import fs from 'node:fs';
import Database from 'better-sqlite3';
import { dbFilePath, MIGRATION_NAMES, openDatabase } from '../../src/db/db.module';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #617: composite indexes for campaign-scoped history reads. Verifies the
 * migration is recorded, indexes exist on fresh + upgraded DBs, and EXPLAIN QUERY
 * PLAN shows the planner using the ordering-aligned composites (not a filesort).
 */
describe('db hot-history composite indexes (#617)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const HOT_HISTORY_INDEXES = [
    'idx_notes_campaign_id_desc',
    'idx_notes_inbox_resolved',
    'idx_comments_entity',
    'idx_comments_campaign_id',
    'idx_scheduled_sessions_campaign_at',
    'idx_timeline_events_campaign_sort',
    'idx_dice_rolls_campaign_id_desc',
  ] as const;

  const LEGACY_INDEXES = [
    'idx_notes_campaign',
    'idx_scheduled_sessions_campaign',
    'idx_timeline_events_campaign',
    'idx_dice_rolls_campaign',
  ] as const;

  const HISTORY_TABLES = ['notes', 'comments', 'scheduled_sessions', 'timeline_events', 'dice_rolls'] as const;

  function indexNames(sqlite: Database.Database, table: string): string[] {
    return (sqlite.pragma(`index_list(${table})`) as Array<{ name: string }>).map((row) => row.name);
  }

  function allHistoryIndexNames(sqlite: Database.Database): string[] {
    return HISTORY_TABLES.flatMap((table) => indexNames(sqlite, table));
  }

  function explainDetail(sqlite: Database.Database, sql: string, ...params: unknown[]): string {
    const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail?: string }>;
    return rows.map((row) => row.detail ?? '').join('\n');
  }

  function usesIndex(sqlite: Database.Database, sql: string, indexName: string, ...params: unknown[]): void {
    const plan = explainDetail(sqlite, sql, ...params);
    expect(plan).toContain(indexName);
    expect(plan).not.toMatch(/USE TEMP B-TREE/i);
  }

  it('records migration 0084 and creates every composite index on a fresh DB', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      expect(MIGRATION_NAMES).toContain('0084_hot_history_composite_indexes');
      const indexes = allHistoryIndexNames(sqlite);
      for (const index of HOT_HISTORY_INDEXES) {
        expect(indexes).toContain(index);
      }
      for (const legacy of LEGACY_INDEXES) {
        expect(indexes).not.toContain(legacy);
      }
    } finally {
      sqlite.close();
    }
  });

  it('rebuilds composites when upgrading a DB that still has legacy indexes', () => {
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec(`
        DROP INDEX IF EXISTS idx_notes_campaign_id_desc;
        DROP INDEX IF EXISTS idx_notes_inbox_resolved;
        DROP INDEX IF EXISTS idx_comments_campaign_id;
        DROP INDEX IF EXISTS idx_scheduled_sessions_campaign_at;
        DROP INDEX IF EXISTS idx_timeline_events_campaign_sort;
        DROP INDEX IF EXISTS idx_dice_rolls_campaign_id_desc;

        CREATE INDEX IF NOT EXISTS idx_notes_campaign ON notes(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(campaign_id, entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_campaign ON scheduled_sessions(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_timeline_events_campaign ON timeline_events(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_dice_rolls_campaign ON dice_rolls(campaign_id);

        DELETE FROM __migrations WHERE name = '0084_hot_history_composite_indexes';
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(indexNames(upgraded.sqlite, 'notes')).toEqual(
        expect.arrayContaining(['idx_notes_campaign_id_desc', 'idx_notes_inbox_resolved']),
      );
      expect(indexNames(upgraded.sqlite, 'comments')).toEqual(
        expect.arrayContaining(['idx_comments_entity', 'idx_comments_campaign_id']),
      );
      expect(indexNames(upgraded.sqlite, 'scheduled_sessions')).toContain('idx_scheduled_sessions_campaign_at');
      expect(indexNames(upgraded.sqlite, 'timeline_events')).toContain('idx_timeline_events_campaign_sort');
      expect(indexNames(upgraded.sqlite, 'dice_rolls')).toContain('idx_dice_rolls_campaign_id_desc');
      const upgradedIndexes = allHistoryIndexNames(upgraded.sqlite);
      for (const legacy of LEGACY_INDEXES) {
        expect(upgradedIndexes).not.toContain(legacy);
      }
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('EXPLAIN QUERY PLAN uses the ordering-aligned composites for hot history reads', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      const now = '2026-07-24T00:00:00.000Z';
      sqlite.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Perf Camp', ?, ?)").run(now, now);
      sqlite
        .prepare(
          `INSERT INTO notes (campaign_id, author_user_id, kind, visibility, body, resolved, created_at, updated_at)
           VALUES (1, 'u1', 'note', 'party_shared', 'hello', 0, ?, ?),
                  (1, 'u1', 'inbox', 'private', 'todo', 1, ?, ?)`,
        )
        .run(now, now, now, now);
      sqlite
        .prepare(
          `INSERT INTO comments (campaign_id, entity_type, entity_id, author_user_id, body, created_at, updated_at)
           VALUES (1, 'session', 9, 'u1', 'thread', ?, ?)`,
        )
        .run(now, now);
      sqlite
        .prepare(
          `INSERT INTO scheduled_sessions (campaign_id, scheduled_at, title, created_at, updated_at)
           VALUES (1, ?, 'Session', ?, ?)`,
        )
        .run(now, now, now);
      sqlite
        .prepare(
          `INSERT INTO timeline_events (campaign_id, title, sort_index, created_at, updated_at)
           VALUES (1, 'Beat', 2, ?, ?)`,
        )
        .run(now, now);
      sqlite
        .prepare("INSERT INTO dice_rolls (campaign_id, roller_user_id, expr, total, created_at) VALUES (1, 'u1', '1d20', 14, ?)")
        .run(now);

      usesIndex(
        sqlite,
        'SELECT id FROM notes WHERE campaign_id = ? ORDER BY id DESC LIMIT 20',
        'idx_notes_campaign_id_desc',
        1,
      );
      usesIndex(
        sqlite,
        `SELECT id FROM notes
         WHERE campaign_id = ? AND kind = 'inbox' AND resolved = 1
         ORDER BY updated_at DESC, id DESC LIMIT 20`,
        'idx_notes_inbox_resolved',
        1,
      );
      usesIndex(
        sqlite,
        `SELECT id FROM comments
         WHERE campaign_id = ? AND entity_type = ? AND entity_id = ?
         ORDER BY id ASC LIMIT 50`,
        'idx_comments_entity',
        1,
        'session',
        9,
      );
      usesIndex(
        sqlite,
        'SELECT id FROM comments WHERE campaign_id = ? ORDER BY id ASC LIMIT 200',
        'idx_comments_campaign_id',
        1,
      );
      usesIndex(
        sqlite,
        'SELECT id FROM scheduled_sessions WHERE campaign_id = ? ORDER BY scheduled_at ASC, id ASC LIMIT 50',
        'idx_scheduled_sessions_campaign_at',
        1,
      );
      usesIndex(
        sqlite,
        'SELECT id FROM timeline_events WHERE campaign_id = ? ORDER BY sort_index ASC, id ASC LIMIT 100',
        'idx_timeline_events_campaign_sort',
        1,
      );
      usesIndex(
        sqlite,
        'SELECT id FROM dice_rolls WHERE campaign_id = ? ORDER BY id DESC LIMIT 50',
        'idx_dice_rolls_campaign_id_desc',
        1,
      );
    } finally {
      sqlite.close();
    }
  });
});
