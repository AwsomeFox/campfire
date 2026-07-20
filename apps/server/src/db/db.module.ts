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
 * Migration for DBs created before per-user text size: `users.text_size`
 * didn't exist. Plain NOT NULL DEFAULT 'default' ADD COLUMN — no table
 * rebuild needed, same as migrateUsersTableForAccentColor above. New DBs
 * never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateUsersTableForTextSize(sqlite: Database.Database): void {
  const hasUsersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const hasTextSize = columns.some((c) => c.name === 'text_size');
  if (hasTextSize) return;

  sqlite.exec("ALTER TABLE users ADD COLUMN text_size TEXT NOT NULL DEFAULT 'default'");
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

/**
 * P1 security fix migration: `api_tokens.admin_enabled` didn't exist before a
 * token's `scope` was found to cap only per-campaign role, NOT server-wide
 * capability — a viewer-scoped PAT minted for a server admin still passed
 * every @ServerRoles('admin') gate and install_rule_pack. Plain NOT NULL
 * DEFAULT 0 ADD COLUMN — no table rebuild needed, same as
 * migrateCampaignsTableForMapAttachment above. Defaulting to 0 (false) is the
 * safe direction: every pre-existing token becomes non-admin-capable on
 * upgrade, even if its owner is a server admin — operators who need an
 * admin-capable token must explicitly mint a new one (adminEnabled:true) as a
 * currently-real admin. New DBs never hit this path — BOOTSTRAP_SQL already
 * declares the column.
 */
function migrateApiTokensTableForAdminEnabled(sqlite: Database.Database): void {
  const hasApiTokensTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_tokens'")
    .get();
  if (!hasApiTokensTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(api_tokens)').all() as Array<{ name: string }>;
  const hasAdminEnabled = columns.some((c) => c.name === 'admin_enabled');
  if (hasAdminEnabled) return;

  sqlite.exec('ALTER TABLE api_tokens ADD COLUMN admin_enabled INTEGER NOT NULL DEFAULT 0');
}

/**
 * Migration for DBs created before proposal before/after diffs:
 * `proposals.snapshot` didn't exist. Plain nullable ADD COLUMN — no table
 * rebuild needed, same as migrateCampaignsTableForMapAttachment above.
 * Pre-existing proposals keep a NULL snapshot (there is no way to reconstruct
 * the entity's state at their propose time); the review UI falls back to
 * showing proposed values only for those rows. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column.
 */
function migrateProposalsTableForSnapshot(sqlite: Database.Database): void {
  const hasProposalsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'")
    .get();
  if (!hasProposalsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>;
  const hasSnapshot = columns.some((c) => c.name === 'snapshot');
  if (hasSnapshot) return;

  sqlite.exec('ALTER TABLE proposals ADD COLUMN snapshot TEXT');
}

/**
 * Migration for DBs created before character-sheet depth (issue #1):
 * `characters.save_proficiencies` / `skills` / `actions` / `spell_slots`
 * didn't exist. Plain defaulted ADD COLUMNs — no table rebuild needed, same
 * as migrateCampaignsTableForRuleSystem above. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the columns.
 */
function migrateCharactersTableForSheetDepth(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharactersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);

  if (!has('save_proficiencies')) sqlite.exec("ALTER TABLE characters ADD COLUMN save_proficiencies TEXT NOT NULL DEFAULT '[]'");
  if (!has('skills')) sqlite.exec("ALTER TABLE characters ADD COLUMN skills TEXT NOT NULL DEFAULT '{}'");
  if (!has('actions')) sqlite.exec("ALTER TABLE characters ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'");
  if (!has('spell_slots')) sqlite.exec("ALTER TABLE characters ADD COLUMN spell_slots TEXT NOT NULL DEFAULT '{}'");
}

/**
 * Migration for DBs created before session scheduling (issue #13):
 * `campaigns.ics_token` didn't exist. Plain nullable ADD COLUMN — no table
 * rebuild needed, same as migrateCampaignsTableForMapAttachment above.
 * New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateCampaignsTableForIcsToken(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  const hasIcsToken = columns.some((c) => c.name === 'ics_token');
  if (hasIcsToken) return;

  sqlite.exec('ALTER TABLE campaigns ADD COLUMN ics_token TEXT');
}

/**
 * Migration for DBs created before XP tracking (issue #14): `characters.xp`
 * didn't exist. Plain NOT NULL DEFAULT 0 ADD COLUMN — no table rebuild needed,
 * same as migrateApiTokensTableForAdminEnabled above. New DBs never hit this
 * path — BOOTSTRAP_SQL already declares the column.
 */
function migrateCharactersTableForXp(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharactersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  const hasXp = columns.some((c) => c.name === 'xp');
  if (hasXp) return;

  sqlite.exec('ALTER TABLE characters ADD COLUMN xp INTEGER NOT NULL DEFAULT 0');
}

/**
 * Migration for DBs created before entity-level secrecy (issue #42):
 * `quests.hidden` / `npcs.hidden` didn't exist. Plain NOT NULL DEFAULT 0 ADD
 * COLUMNs — no table rebuild needed, same as migrateCharactersTableForXp above.
 * Defaulting to 0 (false = visible) preserves the pre-migration behavior for
 * existing rows (nothing suddenly disappears from players); the DM opts a given
 * entity into secrecy by setting hidden=true. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the columns.
 */
function migrateQuestsTableForHidden(sqlite: Database.Database): void {
  const hasQuestsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quests'")
    .get();
  if (!hasQuestsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(quests)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'hidden')) return;

  sqlite.exec('ALTER TABLE quests ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}

function migrateNpcsTableForHidden(sqlite: Database.Database): void {
  const hasNpcsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='npcs'")
    .get();
  if (!hasNpcsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(npcs)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'hidden')) return;

  sqlite.exec('ALTER TABLE npcs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
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
  migrateUsersTableForTextSize(sqlite);
  migrateCampaignsTableForMapAttachment(sqlite);
  migrateApiTokensTableForAdminEnabled(sqlite);
  migrateProposalsTableForSnapshot(sqlite);
  migrateCharactersTableForSheetDepth(sqlite);
  migrateCampaignsTableForIcsToken(sqlite);
  migrateCharactersTableForXp(sqlite);
  migrateQuestsTableForHidden(sqlite);
  migrateNpcsTableForHidden(sqlite);
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
