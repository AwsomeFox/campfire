import fs from 'node:fs';
import { openDatabase, MIGRATION_NAMES } from '../../src/db/db.module';
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
      expect(columnNames(sqlite, 'npcs')).toContain('icon_slug'); // 0037 (issue #302)
      expect(columnNames(sqlite, 'sessions')).toContain('dm_secret');
      expect(columnNames(sqlite, 'api_tokens')).toContain('admin_enabled');
      expect(columnNames(sqlite, 'proposals')).toContain('snapshot');
      expect(columnNames(sqlite, 'encounters')).toEqual(
        expect.arrayContaining(['current_combatant_id', 'location_id', 'quest_id', 'session_id', 'hidden']),
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

  // ── schema-version table (issue #69) ────────────────────────────────────────

  it('records every applied migration in the __migrations version table', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir); // old-shaped DB with none of the migrations recorded yet.

    const { sqlite } = openDatabase(dataDir);
    try {
      // The version table exists and lists exactly the ordered migration registry —
      // every hand-rolled migrate* step is now a recorded, run-once operation.
      const recorded = (sqlite.prepare('SELECT name FROM __migrations ORDER BY name').all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(recorded).toEqual([...MIGRATION_NAMES].sort());
      // Each carries an applied_at timestamp (non-empty ISO string).
      const rows = sqlite.prepare('SELECT name, applied_at FROM __migrations').all() as Array<{ applied_at: string }>;
      expect(rows.every((r) => typeof r.applied_at === 'string' && r.applied_at.length > 0)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('does not re-run or duplicate recorded migrations on a second open', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const first = openDatabase(dataDir);
    const countAfterFirst = countRows(first.sqlite, '__migrations');
    first.sqlite.close();

    // A fresh DB records all of them too (each is a no-op — the tables don't exist
    // when it runs — but the bootstrap schema already includes what they'd add).
    expect(countAfterFirst).toBe(MIGRATION_NAMES.length);

    const second = openDatabase(dataDir);
    try {
      // Re-opening records nothing new (no duplicate rows, PRIMARY KEY on name).
      expect(countRows(second.sqlite, '__migrations')).toBe(countAfterFirst);
    } finally {
      second.sqlite.close();
    }
  });

  // ── foreign-key enforcement on FRESH DBs (issue #69) ────────────────────────

  it('enforces foreign keys on a fresh DB and CASCADEs children on a campaign delete', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      // Enforcement is turned on by openDatabase.
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

      const now = '2026-01-01T00:00:00.000Z';
      sqlite.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'FK Camp', ?, ?)").run(now, now);
      sqlite
        .prepare("INSERT INTO characters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Hero', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO encounters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Fight', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO combatants (id, encounter_id, character_id, kind, name) VALUES (1, 1, 1, 'pc', 'Hero')")
        .run();
      sqlite.prepare("INSERT INTO quests (id, campaign_id, title, created_at, updated_at) VALUES (1, 1, 'Q', ?, ?)").run(now, now);
      sqlite.prepare("INSERT INTO quest_objectives (id, quest_id, text) VALUES (1, 1, 'do it')").run();

      // Deleting the campaign ROW alone — no manual child deletes — must cascade to
      // every strict child AND the two-hop children (combatants off encounters,
      // quest_objectives off quests). This proves the constraints, not the service.
      sqlite.prepare('DELETE FROM campaigns WHERE id = 1').run();

      expect(countRows(sqlite, 'characters')).toBe(0);
      expect(countRows(sqlite, 'encounters')).toBe(0);
      expect(countRows(sqlite, 'combatants')).toBe(0);
      expect(countRows(sqlite, 'quests')).toBe(0);
      expect(countRows(sqlite, 'quest_objectives')).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('SET NULLs a soft reference (combatant.character_id) when a character is deleted', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      sqlite.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'FK Camp', ?, ?)").run(now, now);
      sqlite
        .prepare("INSERT INTO characters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Hero', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO encounters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Fight', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO combatants (id, encounter_id, character_id, kind, name) VALUES (1, 1, 1, 'pc', 'Hero')")
        .run();
      sqlite
        .prepare('INSERT INTO campaign_members (id, campaign_id, user_id, role, character_id, created_at, updated_at) VALUES (1, 1, 7, \'player\', 1, ?, ?)')
        .run(now, now);

      // Deleting the character must NOT delete the combatant / member — their soft
      // link is nulled and the rows stay (no dangling reference to a ghost id).
      sqlite.prepare('DELETE FROM characters WHERE id = 1').run();

      expect(countRows(sqlite, 'combatants')).toBe(1);
      expect((sqlite.prepare('SELECT character_id FROM combatants WHERE id = 1').get() as { character_id: unknown }).character_id).toBeNull();
      expect(countRows(sqlite, 'campaign_members')).toBe(1);
      expect((sqlite.prepare('SELECT character_id FROM campaign_members WHERE id = 1').get() as { character_id: unknown }).character_id).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('rejects an insert that violates a foreign key on a fresh DB', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      // A character referencing a non-existent campaign must be rejected outright —
      // enforcement is genuinely ON, not merely declared.
      expect(() =>
        sqlite
          .prepare("INSERT INTO characters (campaign_id, name, created_at, updated_at) VALUES (999, 'Orphan', '', '')")
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      sqlite.close();
    }
  });
});
