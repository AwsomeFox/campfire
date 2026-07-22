import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  dbFilePath,
  openDatabase,
  MIGRATION_NAMES,
  compareAppVersions,
  getRecordedAppVersion,
} from '../../src/db/db.module';
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
        expect.arrayContaining(['rule_system', 'map_attachment_id', 'ics_token', 'ics_token_expires_at', 'public_recap_sharing_enabled']),
      );
      expect(columnNames(sqlite, 'characters')).toEqual(
        expect.arrayContaining(['xp', 'save_proficiencies', 'skills', 'actions', 'spell_slots', 'dm_secret']),
      );
      expect(columnNames(sqlite, 'quests')).toContain('hidden');
      expect(columnNames(sqlite, 'npcs')).toContain('hidden');
      expect(columnNames(sqlite, 'npcs')).toContain('icon_slug'); // 0037 (issue #302)
      expect(columnNames(sqlite, 'rule_entries')).toContain('icon_slug'); // 0038 (issue #305)
      expect(columnNames(sqlite, 'sessions')).toContain('dm_secret');
      expect(columnNames(sqlite, 'api_tokens')).toContain('admin_enabled');
      expect(columnNames(sqlite, 'oauth_access_tokens')).toEqual(
        expect.arrayContaining(['family_id', 'refresh_consumed_at', 'revoked_at', 'family_revoked_at']),
      );
      expect(
        (sqlite.pragma('index_list(oauth_access_tokens)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_oauth_access_tokens_family');
      expect(columnNames(sqlite, 'proposals')).toContain('snapshot');
      expect(columnNames(sqlite, 'encounters')).toEqual(
        expect.arrayContaining(['current_combatant_id', 'location_id', 'quest_id', 'session_id', 'hidden']),
      );
      expect(columnNames(sqlite, 'combatants')).toEqual(
        expect.arrayContaining(['hp_temp', 'death_state', 'death_save_successes', 'death_save_failures', 'npc_id']),
      );
      expect(columnNames(sqlite, 'attachments')).toContain('hidden');
      expect(columnNames(sqlite, 'inventory_items')).toContain('icon_slug'); // 0039 (issue #307)
      // 0045 (issue #503): comments gain the tombstone columns — soft delete without
      // destroying other members' replies (deleted_at) + who pulled the trigger (deleted_by).
      expect(columnNames(sqlite, 'comments')).toEqual(expect.arrayContaining(['deleted_at', 'deleted_by']));

      // 0040 (issue #310): the ai_provider_configs table is created as a NEW table
      // by the migration, with the encrypted-key + scope columns present.
      expect(columnNames(sqlite, 'ai_provider_configs')).toEqual(
        expect.arrayContaining([
          'scope',
          'campaign_id',
          'provider_type',
          'base_url',
          'model',
          'params',
          'encrypted_api_key',
          'key_last4',
          'allowed_models',
        ]),
      );

      // 0041 (issue #311): ai_dm_seats gains the operating-mode column.
      expect(columnNames(sqlite, 'ai_dm_seats')).toContain('mode');
      // 0043 (issue #316): the AI scribe config + jobs tables are created as NEW
      // tables by the migration, with the trigger/budget + job-record columns present.
      expect(columnNames(sqlite, 'ai_scribe_configs')).toEqual(
        expect.arrayContaining(['campaign_id', 'post_session', 'cron', 'budget_per_run']),
      );
      expect(columnNames(sqlite, 'ai_scribe_jobs')).toEqual(
        expect.arrayContaining(['campaign_id', 'trigger', 'status', 'source_hash', 'proposal_id', 'proposal_count', 'tokens_used', 'provider']),
      );
      // 0052 (#877): a new participant-owned table, with privacy-safe defaults.
      expect(columnNames(sqlite, 'participant_support_preferences')).toEqual(
        expect.arrayContaining(['campaign_id', 'owner_user_id', 'owner_name', 'support_text', 'visibility', 'ai_use_consent']),
      );
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
      expect(campaign).toMatchObject({ name: 'Legacy Campaign', rule_system: '', public_recap_sharing_enabled: 1 });
      expect(campaign.ics_token).toBeNull();
      // 0049 (issue #554): the ICS token expiry column is added by migration on
      // old-shaped DBs, null on the legacy row (no expiry until the DM rotates).
      expect(campaign.ics_token_expires_at).toBeNull();

      const character = sqlite.prepare('SELECT * FROM characters WHERE id = 1').get() as Record<string, unknown>;
      expect(character).toMatchObject({ name: 'Legacy Hero', hp_current: 17, hp_max: 24, xp: 0, dm_secret: '' });
      expect(character.spell_slots).toBe('{}');

      expect((sqlite.prepare('SELECT hidden FROM quests WHERE id = 1').get() as { hidden: number }).hidden).toBe(0);
      expect((sqlite.prepare('SELECT hidden FROM npcs WHERE id = 1').get() as { hidden: number }).hidden).toBe(0);
      // 0039 (issue #307): icon_slug ADD COLUMN backfills the pre-existing item with ''.
      expect((sqlite.prepare('SELECT icon_slug FROM inventory_items WHERE id = 1').get() as { icon_slug: string }).icon_slug).toBe('');
      expect((sqlite.prepare('SELECT admin_enabled FROM api_tokens WHERE id = 1').get() as { admin_enabled: number }).admin_enabled).toBe(0);
      expect(
        sqlite
          .prepare('SELECT family_id, refresh_consumed_at, revoked_at, family_revoked_at FROM oauth_access_tokens WHERE id = 1')
          .get(),
      ).toEqual({ family_id: 'legacy-1', refresh_consumed_at: null, revoked_at: null, family_revoked_at: null });
      expect((sqlite.prepare('SELECT snapshot FROM proposals WHERE id = 1').get() as { snapshot: unknown }).snapshot).toBeNull();

      // Combatant HP-model backfill (issue #57): defaults applied to the pre-existing row.
      const combatant = sqlite.prepare('SELECT * FROM combatants WHERE id = 1').get() as Record<string, unknown>;
      expect(combatant).toMatchObject({ name: 'Legacy Goblin', hp_current: 5, hp_max: 7, hp_temp: 0, death_state: 'none' });
      expect(combatant.death_save_successes).toBe(0);
      expect(combatant.death_save_failures).toBe(0);
      expect(combatant.npc_id).toBeNull(); // 0044: npc_id ADD COLUMN — null for the pre-existing row



      // rule_entries icon_slug (0038, issue #305): ADD COLUMN default backfills the row.
      const ruleEntry = sqlite.prepare('SELECT * FROM rule_entries WHERE id = 1').get() as Record<string, unknown>;
      expect(ruleEntry).toMatchObject({ name: 'Legacy Fireball', type: 'spell', icon_slug: '' });

      // Every seeded table kept exactly its one row (nothing dropped by the rebuild).
      for (const table of ['users', 'campaigns', 'characters', 'quests', 'npcs', 'sessions', 'api_tokens', 'oauth_access_tokens', 'proposals', 'encounters', 'combatants', 'attachments', 'rule_entries', 'inventory_items']) {
        expect(countRows(sqlite, table)).toBe(1);
      }
      // 0045 (issue #503): both seeded comments survived the upgrade, and the
      // reply's parent_id threading is intact (reply still points at the root).
      // The new tombstone columns backfill to NULL on the pre-existing rows.
      expect(countRows(sqlite, 'comments')).toBe(2);
      expect(countRows(sqlite, 'participant_support_preferences')).toBe(0);
      sqlite.prepare(
        "INSERT INTO participant_support_preferences (campaign_id, owner_user_id, support_text, created_at, updated_at) VALUES (1, '1', 'legacy-upgrade-check', '2025-01-01', '2025-01-01')",
      ).run();
      expect(
        sqlite.prepare('SELECT visibility, ai_use_consent FROM participant_support_preferences').get(),
      ).toEqual({ visibility: 'facilitator', ai_use_consent: 0 });
      const legacyRoot = sqlite
        .prepare("SELECT body, parent_id, deleted_at, deleted_by FROM comments WHERE parent_id IS NULL")
        .get() as { body: string; parent_id: number | null; deleted_at: string | null; deleted_by: string | null };
      expect(legacyRoot.body).toBe('Legacy root comment');
      expect(legacyRoot.deleted_at).toBeNull();
      expect(legacyRoot.deleted_by).toBeNull();
      const legacyReply = sqlite
        .prepare("SELECT body, parent_id FROM comments WHERE body = 'Legacy reply that must survive'")
        .get() as { body: string; parent_id: number };
      expect(legacyReply.parent_id).toBe(1);
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

  it('keeps legacy large rows compatible and stores comfortable in the existing TEXT column', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const first = openDatabase(dataDir);
    first.sqlite.prepare("UPDATE users SET text_size = 'large' WHERE id = 1").run();
    first.sqlite.close();

    const second = openDatabase(dataDir);
    expect((second.sqlite.prepare('SELECT text_size FROM users WHERE id = 1').get() as { text_size: string }).text_size).toBe('large');
    second.sqlite.prepare("UPDATE users SET text_size = 'comfortable' WHERE id = 1").run();
    second.sqlite.close();

    const third = openDatabase(dataDir);
    try {
      expect((third.sqlite.prepare('SELECT text_size FROM users WHERE id = 1').get() as { text_size: string }).text_size).toBe('comfortable');
    } finally {
      third.sqlite.close();
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

      expect(columnNames(sqlite, 'oauth_access_tokens')).toEqual(
        expect.arrayContaining(['family_id', 'refresh_consumed_at', 'revoked_at', 'family_revoked_at']),
      );
      expect(
        (sqlite.pragma('index_list(oauth_access_tokens)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_oauth_access_tokens_family');
      expect(columnNames(sqlite, 'participant_support_preferences')).toEqual(
        expect.arrayContaining(['owner_user_id', 'support_text', 'visibility', 'ai_use_consent']),
      );
      expect(MIGRATION_NAMES).toContain('0055_participant_support_preferences');

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

  it('0052 upgrades legacy recap shares with a seven-day sunset and audit metadata columns', () => {
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      const now = '2026-07-22T00:00:00.000Z';
      legacy.prepare("INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (1, 'legacy-share-dm', 'Legacy Share DM', 'hash', 'user', 0, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Legacy Share Campaign', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO sessions (id, campaign_id, number, created_at, updated_at) VALUES (1, 1, 1, ?, ?)").run(now, now);
      legacy.exec(`
        DROP TABLE session_shares;
        CREATE TABLE session_shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          campaign_id INTEGER NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          token_hash TEXT NOT NULL UNIQUE,
          token_prefix TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacy.prepare('INSERT INTO session_shares VALUES (1, 1, 1, ?, ?, ?, ?, ?)').run('1', 'legacy-token-hash', 'cf_share_abcd', now, now);
      legacy.prepare("DELETE FROM __migrations WHERE name = '0052_public_recap_share_policy'").run();
    } finally {
      legacy.close();
    }

    const beforeUpgrade = Date.now();
    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'session_shares')).toEqual(
        expect.arrayContaining(['label', 'expires_at', 'access_count', 'first_accessed_at', 'last_accessed_at']),
      );
      const row = upgraded.sqlite.prepare('SELECT * FROM session_shares WHERE id = 1').get() as Record<string, unknown>;
      expect(row).toMatchObject({ label: '', access_count: 0, created_by: 'Legacy Share DM' });
      const expiry = Date.parse(String(row.expires_at));
      expect(expiry).toBeGreaterThanOrEqual(beforeUpgrade + 6 * 24 * 60 * 60 * 1000);
      expect(expiry).toBeLessThanOrEqual(beforeUpgrade + 8 * 24 * 60 * 60 * 1000);
    } finally {
      upgraded.sqlite.close();
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
      sqlite
        .prepare("INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES (7, 'fk-player', '', 'hash', ?, ?)")
        .run(now, now);
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

  it('0046 removes ghost memberships, records safe repair metadata, and enforces the user FK on upgrade', () => {
    dataDir = makeTempDataDir();

    // Start with the complete current schema, then replace campaign_members with
    // its legacy unconstrained shape and mark 0046 unapplied. This isolates the
    // real production upgrade path without hand-maintaining every unrelated table.
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();
    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      const now = '2026-07-22T00:00:00.000Z';
      legacy.prepare("INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (1, 'real-dm', 'Real DM', 'hash', 'user', 0, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (2, 'linked-player', 'Linked Player', 'hash', 'user', 0, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Legacy Ghost Campaign', ?, ?)").run(now, now);
      legacy.exec(`
        DROP TABLE campaign_members;
        CREATE TABLE campaign_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          character_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(campaign_id, user_id)
        );
      `);
      legacy.prepare("INSERT INTO campaign_members VALUES (1, 1, 1, 'dm', NULL, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaign_members VALUES (2, 1, 999999, 'dm', NULL, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaign_members VALUES (3, 1, 2, 'player', 888888, ?, ?)").run(now, now);
      legacy.prepare("DELETE FROM __migrations WHERE name = '0046_campaign_members_user_fk'").run();
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      const memberships = upgraded.sqlite
        .prepare('SELECT id, user_id, role, character_id FROM campaign_members ORDER BY id')
        .all();
      expect(memberships).toEqual([
        { id: 1, user_id: 1, role: 'dm', character_id: null },
        { id: 3, user_id: 2, role: 'player', character_id: null },
      ]);

      const repairs = upgraded.sqlite
        .prepare('SELECT member_id, user_id, reason, action, invalid_reference_id FROM membership_integrity_repairs ORDER BY member_id')
        .all();
      expect(repairs).toEqual([
        { member_id: 2, user_id: 999999, reason: 'missing_user', action: 'removed_membership', invalid_reference_id: 999999 },
        { member_id: 3, user_id: 2, reason: 'missing_character', action: 'cleared_character', invalid_reference_id: 888888 },
      ]);

      const fks = upgraded.sqlite.pragma('foreign_key_list(campaign_members)') as Array<{ table: string; from: string; on_delete: string }>;
      expect(fks).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'users', from: 'user_id', on_delete: 'CASCADE' }),
      ]));
      expect(() =>
        upgraded.sqlite
          .prepare("INSERT INTO campaign_members (campaign_id, user_id, role, created_at, updated_at) VALUES (1, 123456, 'player', '', '')")
          .run(),
      ).toThrow(/FOREIGN KEY/i);

      upgraded.sqlite.prepare('DELETE FROM users WHERE id = 2').run();
      expect(
        (upgraded.sqlite.prepare('SELECT COUNT(*) AS n FROM campaign_members WHERE user_id = 2').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      upgraded.sqlite.close();
    }
  });

  // ── app-version compatibility guard (issue #726) ──────────────────────────
  //
  // The running binary's APP_VERSION is read from apps/server/package.json
  // (currently 0.14.1). These specs simulate the downgrade scenario — a DB last
  // migrated by a NEWER binary than the one now booting — by opening the file
  // once (which records the binary's own version), then hand-writing a HIGHER
  // version into __db_meta before a second openDatabase() call.

  /** The version openDatabase() will record / compare against (single-sourced from package.json). */
  const BINARY_VERSION = '0.14.1';

  it('compareAppVersions orders semver triples correctly', () => {
    expect(compareAppVersions('0.14.0', '0.14.1')).toBeLessThan(0);
    expect(compareAppVersions('0.14.1', '0.14.1')).toBe(0);
    expect(compareAppVersions('0.14.2', '0.14.1')).toBeGreaterThan(0);
    expect(compareAppVersions('0.15.0', '0.14.99')).toBeGreaterThan(0); // minor beats patch
    expect(compareAppVersions('1.0.0', '0.99.99')).toBeGreaterThan(0); // major beats minor
    // A pre-release suffix is treated as equal to its release (the project does
    // not gate on pre-release ordering; the safe direction for a downgrade guard).
    expect(compareAppVersions('0.14.1-rc.1', '0.14.1')).toBe(0);
    // Malformed stored values collapse to 0.0.0 — they can never read as "newer".
    expect(compareAppVersions('garbage', '0.14.1')).toBeLessThan(0);
  });

  it('records the running binary version in __db_meta after a successful boot', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      expect(getRecordedAppVersion(sqlite)).toBe(BINARY_VERSION);
      const row = sqlite
        .prepare("SELECT value, updated_at FROM __db_meta WHERE key = 'app_version'")
        .get() as { value: string; updated_at: string };
      expect(row.value).toBe(BINARY_VERSION);
      expect(typeof row.updated_at).toBe('string');
      expect(row.updated_at.length).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });

  it('refuses to boot when the DB was last migrated by a NEWER binary (downgrade)', () => {
    dataDir = makeTempDataDir();
    // First boot records the running binary's version and brings the schema up.
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    // Simulate the downgrade: a newer image previously migrated this DB, then an
    // older image was rolled out against it. We hand-stamp a higher recorded
    // version than THIS binary.
    const stamp = new Database(dbFilePath(dataDir));
    try {
      stamp
        .prepare(
          "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run('0.99.0', '2026-07-21T00:00:00.000Z');
    } finally {
      stamp.close();
    }

    // The older binary must refuse to boot — NOT silently run against the newer
    // schema. The error names the recorded + running versions and the two recourses.
    expect(() => openDatabase(dataDir)).toThrow(/NEWER than this running binary/);
    expect(() => openDatabase(dataDir)).toThrow(/v0\.99\.0/);
    expect(() => openDatabase(dataDir)).toThrow(new RegExp(BINARY_VERSION));
    expect(() => openDatabase(dataDir)).toThrow(/restore the pre-upgrade database snapshot/);
  });

  it('boots normally when the recorded version EQUALS the running binary (same/upgrade path)', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    sqlite.close();

    // Re-stamp the same version (simulating a re-deploy of the same image) — must boot.
    const stamp = new Database(dbFilePath(dataDir));
    try {
      stamp
        .prepare(
          "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(BINARY_VERSION, '2026-07-21T00:00:00.000Z');
    } finally {
      stamp.close();
    }

    expect(() => openDatabase(dataDir)).not.toThrow();
  });

  it('boots normally when the recorded version is OLDER than the running binary (upgrade)', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    sqlite.close();

    // An older image recorded a lower version; this newer binary upgrades it.
    const stamp = new Database(dbFilePath(dataDir));
    try {
      stamp
        .prepare(
          "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run('0.13.0', '2026-01-01T00:00:00.000Z');
    } finally {
      stamp.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      // A successful upgrade ADVANCES the recorded version to the running binary.
      expect(getRecordedAppVersion(upgraded.sqlite)).toBe(BINARY_VERSION);
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('boots a pre-issue-#726 DB (no __db_meta row) and records the version on first open', () => {
    dataDir = makeTempDataDir();
    // Hand-build a DB that has __migrations but predates the __db_meta table —
    // the real shape of every DB created before this change shipped.
    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec('CREATE TABLE __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      legacy.prepare("INSERT INTO __migrations (name, applied_at) VALUES ('0001_users_oidc', ?)").run('2024-01-01');
      expect(getRecordedAppVersion(legacy)).toBeNull();
    } finally {
      legacy.close();
    }

    // openDatabase treats a null recorded version as compatible (nothing to be
    // newer than) and records THIS binary's version on the successful boot.
    const opened = openDatabase(dataDir);
    try {
      expect(getRecordedAppVersion(opened.sqlite)).toBe(BINARY_VERSION);
    } finally {
      opened.sqlite.close();
    }
  });
});
