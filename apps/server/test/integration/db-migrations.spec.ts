import fs from 'node:fs';
import { openDatabase } from '../../src/db/db.module';
import { makeTempDataDir, writeOldSchemaDb, columnNames, countRows } from './fixtures';

/**
 * Integration coverage for the hand-rolled ADD-COLUMN / table-rebuild migrations
 * in db.module (issue #80). These run against a real better-sqlite3 file that is
 * deliberately created in an *old shape* (see writeOldSchemaDb): every column a
 * migration adds is missing, and every table carries a seeded row. openDatabase
 * must bring the schema forward without losing that data, and must be safe to
 * run again on the already-migrated file (boot is not once-only — DbHolder
 * re-runs it on every restore).
 *
 * No Nest bootstrap: this is a pure storage-layer spec, so it lives beside the
 * fast `*.spec.ts` unit layer (issue #79) rather than the HTTP e2e suites.
 */
describe('db migrations (real SQLite, old-shaped DB)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('adds every migrated column when upgrading an old-shaped DB', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      // users — the 12-step rebuild path (password_hash NOT NULL -> nullable) plus later ADDs.
      const userCols = columnNames(sqlite, 'users');
      expect(userCols).toEqual(expect.arrayContaining(['oidc_sub', 'accent_color', 'text_size']));

      expect(columnNames(sqlite, 'campaigns')).toEqual(
        expect.arrayContaining(['rule_system', 'map_attachment_id', 'ics_token']),
      );
      expect(columnNames(sqlite, 'characters')).toEqual(
        expect.arrayContaining(['xp', 'save_proficiencies', 'skills', 'actions', 'spell_slots', 'dm_secret']),
      );
      expect(columnNames(sqlite, 'quests')).toContain('hidden');
      expect(columnNames(sqlite, 'npcs')).toContain('hidden');
      expect(columnNames(sqlite, 'sessions')).toContain('dm_secret');
      expect(columnNames(sqlite, 'api_tokens')).toContain('admin_enabled');
      expect(columnNames(sqlite, 'proposals')).toContain('snapshot');
      expect(columnNames(sqlite, 'encounters')).toEqual(
        expect.arrayContaining(['current_combatant_id', 'location_id', 'quest_id', 'session_id']),
      );
      expect(columnNames(sqlite, 'combatants')).toEqual(
        expect.arrayContaining(['hp_temp', 'death_state', 'death_save_successes', 'death_save_failures']),
      );
      expect(columnNames(sqlite, 'attachments')).toContain('hidden');
    } finally {
      sqlite.close();
    }
  });

  it('preserves seeded rows and applies the declared defaults after migrating', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      // The 12-step users rebuild must keep the id/username/role of the legacy row.
      const user = sqlite.prepare('SELECT * FROM users WHERE username = ?').get('legacy-dm') as Record<string, unknown>;
      expect(user).toMatchObject({ id: 1, server_role: 'admin', password_hash: 'legacy-hash' });
      expect(user.oidc_sub).toBeNull();
      expect(user.text_size).toBe('default'); // NOT NULL DEFAULT applied to the pre-existing row.

      // ADD COLUMN with a default backfills existing rows.
      const campaign = sqlite.prepare('SELECT * FROM campaigns WHERE id = 1').get() as Record<string, unknown>;
      expect(campaign).toMatchObject({ name: 'Legacy Campaign', rule_system: '' });
      expect(campaign.ics_token).toBeNull();

      const character = sqlite.prepare('SELECT * FROM characters WHERE id = 1').get() as Record<string, unknown>;
      expect(character).toMatchObject({ name: 'Legacy Hero', hp_current: 17, hp_max: 24, xp: 0, dm_secret: '' });
      expect(character.spell_slots).toBe('{}');

      expect((sqlite.prepare('SELECT hidden FROM quests WHERE id = 1').get() as { hidden: number }).hidden).toBe(0);
      expect((sqlite.prepare('SELECT hidden FROM npcs WHERE id = 1').get() as { hidden: number }).hidden).toBe(0);
      expect((sqlite.prepare('SELECT admin_enabled FROM api_tokens WHERE id = 1').get() as { admin_enabled: number }).admin_enabled).toBe(0);
      expect((sqlite.prepare('SELECT snapshot FROM proposals WHERE id = 1').get() as { snapshot: unknown }).snapshot).toBeNull();

      // Combatant HP-model backfill (issue #57): defaults applied to the pre-existing row.
      const combatant = sqlite.prepare('SELECT * FROM combatants WHERE id = 1').get() as Record<string, unknown>;
      expect(combatant).toMatchObject({ name: 'Legacy Goblin', hp_current: 5, hp_max: 7, hp_temp: 0, death_state: 'none' });
      expect(combatant.death_save_successes).toBe(0);
      expect(combatant.death_save_failures).toBe(0);

      // Every seeded table kept exactly its one row (nothing dropped by the rebuild).
      for (const table of ['users', 'campaigns', 'characters', 'quests', 'npcs', 'sessions', 'api_tokens', 'proposals', 'encounters', 'combatants', 'attachments']) {
        expect(countRows(sqlite, table)).toBe(1);
      }
    } finally {
      sqlite.close();
    }
  });

  it('relaxes users.password_hash to nullable so an OIDC-only row can be inserted', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      // Would have thrown against the old NOT NULL constraint; the rebuild dropped it.
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO users (username, display_name, password_hash, oidc_sub, created_at, updated_at) VALUES ('oidc-user', 'OIDC User', NULL, 'sub-123', '2025-01-01', '2025-01-01')",
          )
          .run(),
      ).not.toThrow();
      const row = sqlite.prepare('SELECT password_hash, oidc_sub FROM users WHERE username = ?').get('oidc-user');
      expect(row).toEqual({ password_hash: null, oidc_sub: 'sub-123' });
    } finally {
      sqlite.close();
    }
  });

  it('is idempotent — re-running migrations on the already-migrated file is a no-op', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    // First upgrade.
    const first = openDatabase(dataDir);
    const usersAfterFirst = columnNames(first.sqlite, 'users').sort();
    first.sqlite.close();

    // DbHolder re-opens the same file on every restore — this must not throw or
    // re-run a rebuild, and the schema/data must be byte-for-byte the same.
    const second = openDatabase(dataDir);
    try {
      expect(columnNames(second.sqlite, 'users').sort()).toEqual(usersAfterFirst);
      expect(countRows(second.sqlite, 'users')).toBe(1);
      expect(countRows(second.sqlite, 'characters')).toBe(1);
      // A third pass for good measure — still stable.
      const third = openDatabase(dataDir);
      expect(columnNames(third.sqlite, 'campaigns')).toContain('ics_token');
      third.sqlite.close();
    } finally {
      second.sqlite.close();
    }
  });

  it('creates a fully-formed DB from scratch and reports FTS availability', () => {
    dataDir = makeTempDataDir();
    const { sqlite, orm, ftsAvailable } = openDatabase(dataDir);
    try {
      expect(orm).toBeDefined();
      // better-sqlite3's bundled build ships fts5, so the probe should succeed here.
      expect(ftsAvailable).toBe(true);
      // Fresh DB already has the modern columns (never touched a migration path).
      expect(columnNames(sqlite, 'characters')).toEqual(expect.arrayContaining(['xp', 'dm_secret', 'spell_slots']));
      expect(columnNames(sqlite, 'users')).toEqual(expect.arrayContaining(['oidc_sub', 'accent_color', 'text_size']));
      // WAL mode is set on open.
      expect((sqlite.pragma('journal_mode', { simple: true }) as string).toLowerCase()).toBe('wal');
    } finally {
      sqlite.close();
    }
  });
});
