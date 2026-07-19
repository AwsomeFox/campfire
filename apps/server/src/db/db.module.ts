import { Global, Module } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BOOTSTRAP_SQL, RULE_ENTRIES_FTS_SQL } from './bootstrap.sql';
import * as schema from './schema';

export const DB = Symbol('DB');
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

/** Injection token for whether the FTS5 extension is available on this SQLite build (see RulesService). */
export const RULE_ENTRIES_FTS_AVAILABLE = Symbol('RULE_ENTRIES_FTS_AVAILABLE');

/**
 * fts5 ships with better-sqlite3's bundled SQLite by default, but this is not
 * guaranteed on every platform/build (e.g. a system libsqlite3 without fts5
 * compiled in). Probe by attempting the real DDL rather than trusting a
 * version string, and fall back to a LIKE-based search (see
 * rules/rules.service.ts) if it fails — documented in README's Rules section.
 */
function setupRuleEntriesFts(sqlite: Database.Database): boolean {
  try {
    sqlite.exec(RULE_ENTRIES_FTS_SQL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migration for DBs created before OIDC support: `users.password_hash` was
 * originally `NOT NULL`, and `users.oidc_sub` didn't exist. SQLite has no
 * `ALTER TABLE ... DROP NOT NULL`, so when we detect the old constraint we
 * rebuild the table (the standard SQLite "12-step" pattern) rather than
 * requiring a separate migration-runner for what is, on this project, still
 * a single hand-maintained bootstrap file. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column nullable.
 */
function migrateUsersTableForOidc(sqlite: Database.Database): void {
  const hasUsersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const passwordHashCol = columns.find((c) => c.name === 'password_hash');
  const hasOidcSub = columns.some((c) => c.name === 'oidc_sub');
  const needsNotNullRelax = passwordHashCol && passwordHashCol.notnull === 1;

  if (!needsNotNullRelax && hasOidcSub) return; // already migrated.

  const migrate = sqlite.transaction(() => {
    if (needsNotNullRelax) {
      // Rebuild table with password_hash nullable (SQLite can't alter column
      // constraints in place). oidc_sub is added here too so we only rebuild once.
      sqlite.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL DEFAULT '',
          password_hash TEXT,
          server_role TEXT NOT NULL DEFAULT 'user',
          disabled INTEGER NOT NULL DEFAULT 0,
          oidc_sub TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO users_new (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at)
          SELECT id, username, display_name, password_hash, server_role, disabled, created_at, updated_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    } else if (!hasOidcSub) {
      sqlite.exec('ALTER TABLE users ADD COLUMN oidc_sub TEXT');
    }
  });
  migrate();
}

/**
 * Migration for DBs created before rule packs: `campaigns.rule_system` didn't
 * exist. SQLite supports `ALTER TABLE ... ADD COLUMN` for a simple nullable
 * (or defaulted) column, so this is a plain add — no table rebuild needed,
 * unlike migrateUsersTableForOidc above. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column.
 */
function migrateCampaignsTableForRuleSystem(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  const hasRuleSystem = columns.some((c) => c.name === 'rule_system');
  if (hasRuleSystem) return;

  sqlite.exec("ALTER TABLE campaigns ADD COLUMN rule_system TEXT NOT NULL DEFAULT ''");
}

/**
 * Migration for DBs created before per-user accent colors: `users.accent_color`
 * didn't exist. Plain nullable ADD COLUMN — no table rebuild needed, same as
 * migrateCampaignsTableForRuleSystem above. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column.
 */
function migrateUsersTableForAccentColor(sqlite: Database.Database): void {
  const hasUsersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const hasAccentColor = columns.some((c) => c.name === 'accent_color');
  if (hasAccentColor) return;

  sqlite.exec('ALTER TABLE users ADD COLUMN accent_color TEXT');
}

/**
 * Migration for DBs created before attachments (media uploads):
 * `campaigns.map_attachment_id` didn't exist. Plain nullable ADD COLUMN — no
 * table rebuild needed, same as migrateCampaignsTableForRuleSystem above.
 * New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateCampaignsTableForMapAttachment(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  const hasMapAttachmentId = columns.some((c) => c.name === 'map_attachment_id');
  if (hasMapAttachmentId) return;

  sqlite.exec('ALTER TABLE campaigns ADD COLUMN map_attachment_id INTEGER');
}

// Set by createDb() as a side effect and read by the RULE_ENTRIES_FTS_AVAILABLE
// provider below — both providers must derive from the same sqlite.exec()
// probe (asking twice could disagree if it were ever non-deterministic).
let ruleEntriesFtsAvailable = false;

export function createDb(): DrizzleDb {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'campfire.db');

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  migrateUsersTableForOidc(sqlite);
  migrateCampaignsTableForRuleSystem(sqlite);
  migrateUsersTableForAccentColor(sqlite);
  migrateCampaignsTableForMapAttachment(sqlite);
  sqlite.exec(BOOTSTRAP_SQL);
  // Index creation is IF NOT EXISTS in BOOTSTRAP_SQL, so re-running it above
  // after the rebuild is safe and keeps idx_users_oidc_sub in sync.
  ruleEntriesFtsAvailable = setupRuleEntriesFts(sqlite);

  return drizzle(sqlite, { schema });
}

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: createDb },
    // Depends on DB purely for init ordering — createDb() must run first so
    // ruleEntriesFtsAvailable is set before this factory reads it.
    { provide: RULE_ENTRIES_FTS_AVAILABLE, useFactory: (_db: DrizzleDb) => ruleEntriesFtsAvailable, inject: [DB] },
  ],
  exports: [DB, RULE_ENTRIES_FTS_AVAILABLE],
})
export class DbModule {}
