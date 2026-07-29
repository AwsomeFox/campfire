import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { APP_VERSION } from '../common/build-metadata';
import { BOOTSTRAP_SQL, CAMPAIGN_MODULES_DDL, CAMPAIGN_SEARCH_FTS_SQL, RULE_ENTRIES_FTS_SQL } from './bootstrap.sql';
import { assertDataMount } from './boot-guard';
import * as schema from './schema';

// Re-export the boot-guard surface (issue #721) so callers and tests import it
// from the db module barrel rather than reaching into boot-guard.ts directly —
// keeps the public DB boundary in one place.
export {
  assertDataMount,
  DataMountGuardError,
  sentinelFilePath,
  readInstallSentinel,
  SENTINEL_FILENAME,
  ALLOW_FRESH_DB_ENV,
  type InstallSentinel,
  type BootGuardOutcome,
} from './boot-guard';

export const DB = Symbol('DB');
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

/** Module-scoped logger for the free functions (openDatabase et al.) that run outside a Nest provider. */
const dbLog = new Logger('Database');
const RULE_ENTRIES_FTS_REPAIR_META_KEY = 'rule_entries_fts_repair_v1';

/**
 * APP_VERSION (from common/build-metadata, issue #432) is recorded alongside the
 * migration log in `__db_meta` (issue #726) so a subsequently booted OLDER binary
 * can detect that the DB was last touched by a newer app version and refuse to
 * start against a schema it does not understand, rather than silently writing
 * into it.
 */

/**
 * Startup diagnostic (issue #235): run `PRAGMA foreign_key_check` once enforcement is on
 * and log a warning for any pre-existing referential violation. This is a READ-ONLY probe —
 * it never mutates data (an automatic "repair" that silently deleted dangling rows could
 * destroy real records), it just surfaces the problem so an operator can act. On a fresh DB
 * (constraints enforced from the first write) this is always clean; on a pre-#69 DB — which
 * carries no FK constraints and so cannot report violations against them — it is also a
 * no-op. It only ever fires if a DB somehow accumulated a genuine dangling reference.
 */
function logForeignKeyViolations(sqlite: Database.Database): void {
  try {
    const violations = sqlite.pragma('foreign_key_check') as Array<{
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }>;
    if (violations.length === 0) return;
    const byTable = new Map<string, number>();
    for (const v of violations) byTable.set(v.table, (byTable.get(v.table) ?? 0) + 1);
    const summary = [...byTable.entries()].map(([t, n]) => `${t}(${n})`).join(', ');
    dbLog.warn(
      `foreign_key_check found ${violations.length} dangling reference(s) across: ${summary}. ` +
        `These are orphaned rows referencing a missing parent; no data was changed. ` +
        `Purging the owning campaign (CampaignsService.purge) clears campaign-scoped orphans (issue #235).`,
    );
  } catch (err) {
    // A diagnostic must never block boot.
    dbLog.warn(`foreign_key_check probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Injection token for the DbHolder (raw better-sqlite3 handle + reopen()), used by the backup/restore module. */
export const DB_HOLDER = Symbol('DB_HOLDER');

/** Injection token for whether the FTS5 extension is available on this SQLite build (see RulesService). */
export const RULE_ENTRIES_FTS_AVAILABLE = Symbol('RULE_ENTRIES_FTS_AVAILABLE');
/** Injection token for whether campaign-wide FTS search is available (see SearchService). */
export const CAMPAIGN_SEARCH_FTS_AVAILABLE = Symbol('CAMPAIGN_SEARCH_FTS_AVAILABLE');

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
    // External-content FTS tables read their content table for SELECT count(*),
    // so that count cannot distinguish a populated-but-unindexed legacy table.
    // Repair that historical no-FTS -> FTS upgrade exactly once. A persisted
    // marker avoids rebuilding healthy indexes at every boot and handles both
    // fully empty and partially backfilled legacy indexes without relying on
    // token coverage (some valid rule entries have no tokenizable text).
    ensureDbMetaTable(sqlite);
    const repaired = sqlite
      .prepare('SELECT 1 FROM __db_meta WHERE key = ?')
      .get(RULE_ENTRIES_FTS_REPAIR_META_KEY);
    const entries = sqlite.prepare('SELECT count(*) AS count FROM rule_entries').get() as { count: number };
    if (!repaired) {
      if (entries.count > 0) {
        sqlite.exec("INSERT INTO rule_entries_fts(rule_entries_fts) VALUES ('rebuild')");
        dbLog.log(`rebuilt rule_entries FTS index for ${entries.count} existing entries`);
      }
      sqlite
        .prepare('INSERT INTO __db_meta (key, value, updated_at) VALUES (?, ?, ?)')
        .run(RULE_ENTRIES_FTS_REPAIR_META_KEY, 'complete', new Date().toISOString());
    }
    return true;
  } catch {
    return false;
  }
}

function setupCampaignSearchFts(sqlite: Database.Database): boolean {
  try {
    sqlite.exec(CAMPAIGN_SEARCH_FTS_SQL);
    return true;
  } catch (err) {
    dbLog.warn(`campaign search FTS setup failed; falling back to LIKE/full scan search: ${err instanceof Error ? err.message : String(err)}`);
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
 * Migration for DBs created before per-user time format (issue #634):
 * `users.time_format` didn't exist. Plain NOT NULL DEFAULT 'system' ADD COLUMN.
 */
function migrateUsersTableForTimeFormat(sqlite: Database.Database): void {
  const hasUsersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsersTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const hasTimeFormat = columns.some((c) => c.name === 'time_format');
  if (hasTimeFormat) return;

  sqlite.exec("ALTER TABLE users ADD COLUMN time_format TEXT NOT NULL DEFAULT 'system'");
}

/**
 * Migration for DBs created before per-user dice overlay skins (issue #1315):
 * `users.dice_theme` didn't exist. Plain NOT NULL DEFAULT 'nocturne' ADD COLUMN.
 */
function migrateUsersTableForDiceTheme(sqlite: Database.Database): void {
  const hasUsersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsersTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const hasDiceTheme = columns.some((c) => c.name === 'dice_theme');
  if (hasDiceTheme) return;

  sqlite.exec("ALTER TABLE users ADD COLUMN dice_theme TEXT NOT NULL DEFAULT 'nocturne'");
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
 * Issue #158 migration: `api_tokens.write_scope` didn't exist before a token's
 * write authority was split from its read `scope`. Before this, a dm-scoped
 * token wrote canon DIRECTLY and the proposal path was purely voluntary
 * (?proposed=true) — an AI/DM token meant to only PROPOSE could just omit the
 * flag. Plain NOT NULL DEFAULT 'direct' ADD COLUMN — no table rebuild, same
 * shape as migrateApiTokensTableForAdminEnabled above. Defaulting to 'direct' is
 * the safe/back-compat direction: every pre-existing token keeps writing exactly
 * as it did (none are silently downgraded to read-only, which would break live
 * integrations). Operators who want a propose-only or read-only token mint a new
 * one with writeScope set. New DBs never hit this path — BOOTSTRAP_SQL already
 * declares the column.
 */
function migrateApiTokensTableForWriteScope(sqlite: Database.Database): void {
  const hasApiTokensTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_tokens'")
    .get();
  if (!hasApiTokensTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(api_tokens)').all() as Array<{ name: string }>;
  const hasWriteScope = columns.some((c) => c.name === 'write_scope');
  if (hasWriteScope) return;

  sqlite.exec("ALTER TABLE api_tokens ADD COLUMN write_scope TEXT NOT NULL DEFAULT 'direct'");
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
 * Migration for DBs created before proposer attribution (issue #124): the
 * proposals table stored only a single `proposer` string (the token name or a
 * bare user id). `proposer_user_id` powers the proposer self-view filter, and
 * `proposer_token` keeps token provenance as secondary info. Plain defaulted /
 * nullable ADD COLUMNs — no table rebuild. Pre-existing rows get an empty
 * proposer_user_id (so they surface only to the DM's all-view, never a member
 * self-view) and NULL proposer_token. New DBs never hit this path — BOOTSTRAP_SQL
 * already declares both columns.
 */
function migrateProposalsTableForAttribution(sqlite: Database.Database): void {
  const hasProposalsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'")
    .get();
  if (!hasProposalsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);

  if (!has('proposer_user_id')) sqlite.exec("ALTER TABLE proposals ADD COLUMN proposer_user_id TEXT NOT NULL DEFAULT ''");
  if (!has('proposer_token')) sqlite.exec('ALTER TABLE proposals ADD COLUMN proposer_token TEXT');
}

/**
 * Migration for proposal stale-target detection (issue #681): store the target
 * entity's revision token and a hash of the base snapshot at propose time so
 * approve can reject stale targets with a three-way diff. Plain nullable ADD
 * COLUMNs — pre-existing rows keep NULL and fall back to hashing the persisted
 * snapshot at approve time.
 */
function migrateProposalsTableForBaseSnapshot(sqlite: Database.Database): void {
  const hasProposalsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'")
    .get();
  if (!hasProposalsTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('base_updated_at')) sqlite.exec('ALTER TABLE proposals ADD COLUMN base_updated_at TEXT');
  if (!has('base_snapshot_hash')) sqlite.exec('ALTER TABLE proposals ADD COLUMN base_snapshot_hash TEXT');
}

/**
 * Issue #501: AI consent + generation provenance.
 *
 * Adds the campaign-level external-source policy, per-member consent, and JSON
 * provenance blobs for AI-authored proposals / scribe jobs. Defaults are fail-closed:
 * upgraded members have not consented until they opt in, and manual/legacy artifacts
 * keep NULL provenance.
 */
function migrateAiConsentAndProvenance501(sqlite: Database.Database): void {
  const hasTable = (name: string) =>
    !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const hasColumn = (table: string, column: string) =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);

  if (hasTable('campaigns') && !hasColumn('campaigns', 'ai_external_content_policy')) {
    sqlite.exec("ALTER TABLE campaigns ADD COLUMN ai_external_content_policy TEXT NOT NULL DEFAULT 'member_consent'");
  }
  if (hasTable('campaign_members') && !hasColumn('campaign_members', 'ai_external_use_consent')) {
    sqlite.exec('ALTER TABLE campaign_members ADD COLUMN ai_external_use_consent INTEGER NOT NULL DEFAULT 0');
  }
  if (hasTable('proposals') && !hasColumn('proposals', 'generation_provenance')) {
    sqlite.exec('ALTER TABLE proposals ADD COLUMN generation_provenance TEXT');
  }
  if (hasTable('ai_scribe_jobs') && !hasColumn('ai_scribe_jobs', 'generation_provenance')) {
    sqlite.exec('ALTER TABLE ai_scribe_jobs ADD COLUMN generation_provenance TEXT');
  }
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
  if (!has('resources')) sqlite.exec("ALTER TABLE characters ADD COLUMN resources TEXT NOT NULL DEFAULT '{}'");
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
 * Migration for issue #554: `campaigns.ics_token_expires_at` didn't exist on
 * pre-#554 DBs. Plain nullable ADD COLUMN — no table rebuild needed, same shape
 * as migrateCampaignsTableForIcsToken above. Existing rows (which have no
 * expiry) default to NULL and keep working until the DM rotates; rotating then
 * stamps a fresh expiry on the new token (see SchedulingService.rotateFeed).
 * New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateCampaignsTableForIcsTokenExpiresAt(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'ics_token_expires_at')) return;

  sqlite.exec('ALTER TABLE campaigns ADD COLUMN ics_token_expires_at TEXT');
}

/**
 * Migration for DBs created before per-campaign storage quotas (issue #24):
 * `campaigns.storage_quota_bytes` didn't exist. Plain nullable ADD COLUMN — no
 * table rebuild needed, same as migrateCampaignsTableForIcsToken above. Existing
 * campaigns default to NULL (no quota). New DBs never hit this path — BOOTSTRAP_SQL
 * already declares the column.
 */
function migrateCampaignsTableForStorageQuota(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'storage_quota_bytes')) return;

  sqlite.exec('ALTER TABLE campaigns ADD COLUMN storage_quota_bytes INTEGER');
}

/**
 * Migration for DBs created before the one-authoritative-live-fight invariant
 * (issue #744): `campaigns.active_encounter_id` didn't exist. Plain nullable ADD
 * COLUMN — no table rebuild needed, same shape as
 * migrateCampaignsTableForMapAttachment above. The declared REFERENCES clause is
 * omitted here (added only for fresh DBs via bootstrap) per the #69 convention —
 * SQLite cannot ADD a foreign key to an existing table; the service layer's End
 * clears the pointer, and ON DELETE SET NULL semantics are reproduced in
 * EncountersService.remove(). Existing campaigns get NULL (no active fight),
 * preserving the pre-migration behavior. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column.
 */
function migrateCampaignsTableForActiveEncounter(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'active_encounter_id')) return;

  sqlite.exec('ALTER TABLE campaigns ADD COLUMN active_encounter_id INTEGER');
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
 * Migration for DBs created before character lifecycle status (issue #115):
 * `characters.status` didn't exist, so a dead/retired PC couldn't be marked and
 * was force-added to every new encounter. Plain NOT NULL DEFAULT 'active' ADD
 * COLUMN — every existing character becomes 'active' (preserving today's auto-add
 * behavior), no table rebuild needed, same as migrateCharactersTableForXp above.
 * New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateCharactersTableForStatus(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharactersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  const hasStatus = columns.some((c) => c.name === 'status');
  if (hasStatus) return;

  sqlite.exec("ALTER TABLE characters ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}

/**
 * Migration for DBs created before characters/sessions gained DM-only secrets
 * (issue #59): `characters.dm_secret` and `sessions.dm_secret` didn't exist —
 * quests/NPCs/locations had dmSecret from day one, but a DM couldn't attach a
 * private note to a PC or keep prep notes on a session record. Plain NOT NULL
 * DEFAULT '' ADD COLUMN — no table rebuild needed, same as
 * migrateCampaignsTableForRuleSystem above. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares both columns.
 */
function migrateCharactersTableForDmSecret(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharactersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  const hasDmSecret = columns.some((c) => c.name === 'dm_secret');
  if (hasDmSecret) return;

  sqlite.exec("ALTER TABLE characters ADD COLUMN dm_secret TEXT NOT NULL DEFAULT ''");
}

/**
 * Migration for DBs created before per-player whisper notes (issue #127):
 * `notes.recipient_user_id` didn't exist. Plain nullable ADD COLUMN — no table
 * rebuild needed, same shape as migrateCampaignsTableForMapAttachment above.
 * Existing notes get NULL (no whisper target), which is correct for every
 * pre-migration visibility (private/dm_shared/party_shared never carried a
 * recipient). New DBs never hit this path — BOOTSTRAP_SQL already declares the
 * column.
 */
function migrateNotesTableForRecipient(sqlite: Database.Database): void {
  const hasNotesTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
    .get();
  if (!hasNotesTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'recipient_user_id')) return;

  sqlite.exec('ALTER TABLE notes ADD COLUMN recipient_user_id TEXT');
}

/** See migrateCharactersTableForDmSecret above — same migration for the sessions table. */
function migrateSessionsTableForDmSecret(sqlite: Database.Database): void {
  const hasSessionsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  if (!hasSessionsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const hasDmSecret = columns.some((c) => c.name === 'dm_secret');
  if (hasDmSecret) return;

  sqlite.exec("ALTER TABLE sessions ADD COLUMN dm_secret TEXT NOT NULL DEFAULT ''");
}

/**
 * Migration for DBs created before the identity-based turn pointer (issue #49):
 * `encounters.current_combatant_id` didn't exist. Plain nullable ADD COLUMN — no
 * table rebuild needed, same as migrateCampaignsTableForMapAttachment above.
 * Pre-existing running encounters keep a NULL pointer until the next turn advance
 * (nextTurn re-derives it from the sorted order). New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column.
 */
function migrateEncountersTableForCurrentCombatant(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const hasCurrentCombatantId = columns.some((c) => c.name === 'current_combatant_id');
  if (hasCurrentCombatantId) return;

  sqlite.exec('ALTER TABLE encounters ADD COLUMN current_combatant_id INTEGER');
}

/**
 * Migration for DBs created before encounter linking (issue #126): encounters carried
 * only campaignId + name + status/round/turn, with no way to attach a fight to WHERE
 * (locationId), WHY (questId), or WHEN (sessionId) it happened. Plain nullable ADD
 * COLUMNs, each guarded independently. New DBs never hit this path — BOOTSTRAP_SQL
 * already declares the columns.
 */
function migrateEncountersTableForLinks(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('location_id')) sqlite.exec('ALTER TABLE encounters ADD COLUMN location_id INTEGER');
  if (!has('quest_id')) sqlite.exec('ALTER TABLE encounters ADD COLUMN quest_id INTEGER');
  if (!has('session_id')) sqlite.exec('ALTER TABLE encounters ADD COLUMN session_id INTEGER');
}

/**
 * Migration for DBs created before per-encounter battle maps (issue #39):
 * `encounters.map_attachment_id` didn't exist. Plain nullable ADD COLUMN. New DBs never
 * hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateEncountersTableForMapAttachment(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'map_attachment_id')) return;
  sqlite.exec('ALTER TABLE encounters ADD COLUMN map_attachment_id INTEGER');
}

/**
 * Migration for DBs created before battle-map combatant tokens (issue #39):
 * `combatants.token_x` / `token_y` didn't exist. Plain nullable ADD COLUMNs. New DBs
 * never hit this path — BOOTSTRAP_SQL already declares the columns.
 */
function migrateCombatantsTableForTokenPosition(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('token_x')) sqlite.exec('ALTER TABLE combatants ADD COLUMN token_x REAL');
  if (!has('token_y')) sqlite.exec('ALTER TABLE combatants ADD COLUMN token_y REAL');
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

/**
 * Migration for DBs created before per-attachment visibility (issue #97):
 * `attachments.hidden` didn't exist. Plain NOT NULL DEFAULT 0 ADD COLUMN — no
 * table rebuild needed, same shape as migrateQuestsTableForHidden above.
 *
 * Defaulting existing rows to 0 (visible) deliberately PRESERVES pre-migration
 * behavior — nothing a party could already fetch suddenly 404s on upgrade, and
 * campaign-map backgrounds already assigned to players keep rendering. The
 * secure default (hidden=1 for map/image) applies only to NEW uploads via
 * AttachmentsService.create; a DM can retroactively hide existing prep material
 * with POST /attachments/:id/hide. New DBs never hit this path — BOOTSTRAP_SQL
 * already declares the column.
 */
function migrateAttachmentsTableForHidden(sqlite: Database.Database): void {
  const hasAttachmentsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'")
    .get();
  if (!hasAttachmentsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'hidden')) return;

  sqlite.exec('ALTER TABLE attachments ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}

/**
 * Issue #728 migration: attachment publication became an explicit two-state
 * protocol. Existing rows predate reservations and were already publicly readable,
 * so they must backfill to `committed`; treating them as reservations would hide
 * every existing map/portrait and let startup recovery delete their bytes.
 *
 * The CHECK keeps malformed states from becoming quota-counted but permanently
 * invisible. BOOTSTRAP_SQL creates the companion (campaign_id, state) index after
 * this migration runs. Fresh databases already have the modern declaration.
 */
function migrateAttachmentsTableForPublicationState(sqlite: Database.Database): void {
  const hasAttachmentsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'")
    .get();
  if (!hasAttachmentsTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'state')) return;

  sqlite.exec(
    "ALTER TABLE attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'committed' CHECK (state IN ('reserved', 'committed'))",
  );
}

/**
 * Migration for DBs created before location nesting (issue #99): `locations.parent_id`
 * didn't exist. Plain nullable ADD COLUMN — no table rebuild needed, same shape as
 * migrateQuestsTableForHidden above. Existing rows get NULL (top-level), preserving
 * the pre-migration flat list; the DM opts a location into a hierarchy by setting
 * parentId. New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateLocationsTableForParentId(sqlite: Database.Database): void {
  const hasLocationsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='locations'")
    .get();
  if (!hasLocationsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(locations)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'parent_id')) return;

  sqlite.exec('ALTER TABLE locations ADD COLUMN parent_id INTEGER');
}

/**
 * Migration for DBs created before the richer combat HP model (issue #57):
 * `combatants.hp_temp` / `death_state` / `death_save_successes` /
 * `death_save_failures` didn't exist. Plain defaulted ADD COLUMNs — no table
 * rebuild needed, same shape as migrateCharactersTableForSheetDepth above.
 * Existing rows backfill to 0 temp HP and death_state 'none' (the pre-migration
 * behavior — a combatant simply at [0, hpMax] with no death-save tracking). New
 * DBs never hit this path — BOOTSTRAP_SQL already declares the columns.
 */
function migrateCombatantsTableForHpModel(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);

  if (!has('hp_temp')) sqlite.exec('ALTER TABLE combatants ADD COLUMN hp_temp INTEGER NOT NULL DEFAULT 0');
  if (!has('death_state')) sqlite.exec("ALTER TABLE combatants ADD COLUMN death_state TEXT NOT NULL DEFAULT 'none'");
  if (!has('death_save_successes')) sqlite.exec('ALTER TABLE combatants ADD COLUMN death_save_successes INTEGER NOT NULL DEFAULT 0');
  if (!has('death_save_failures')) sqlite.exec('ALTER TABLE combatants ADD COLUMN death_save_failures INTEGER NOT NULL DEFAULT 0');
}

/**
 * Migration for DBs created before per-entry source labels + the (pack,type,slug)
 * unique index (issue #143): `rule_entries.source` didn't exist, and a fresh Open5e
 * install could write triplicate same-name rows with no way to tell them apart. This
 * does two things on an existing DB, both idempotent:
 *   1. Plain NOT NULL DEFAULT '' ADD COLUMN for `source` — no table rebuild, same as
 *      migrateCharactersTableForDmSecret above.
 *   2. Collapse any exact-duplicate (pack_id, type, slug) rows left by pre-fix installs,
 *      keeping the lowest id, so BOOTSTRAP_SQL's new UNIQUE index can be created cleanly
 *      (a unique index over data with duplicates would otherwise throw and fail boot).
 * Deleting fires the rule_entries AFTER DELETE trigger, keeping the FTS index in sync.
 * New DBs never hit this path — BOOTSTRAP_SQL already declares the column + index.
 */
function migrateRuleEntriesTableForSource(sqlite: Database.Database): void {
  const hasRuleEntriesTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rule_entries'")
    .get();
  if (!hasRuleEntriesTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(rule_entries)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'source')) {
    sqlite.exec("ALTER TABLE rule_entries ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  }

  // Drop exact (pack_id, type, slug) duplicates, keeping the earliest row, so the new
  // unique index can be built. Runs every boot but is a cheap no-op once clean.
  sqlite.exec(`
    DELETE FROM rule_entries
    WHERE id NOT IN (
      SELECT MIN(id) FROM rule_entries GROUP BY pack_id, type, slug
    );
  `);
}

/**
 * Migration for DBs created before dice keep/drop + check context (issue #130):
 * `dice_rolls` gained `kept` (JSON of the kept dice), `label`, and `dc`. Plain nullable
 * ADD COLUMNs — no table rebuild needed, same shape as migrateLocationsTableForParentId
 * above. Existing rolls get NULL for all three (== no keep/drop, no check context),
 * preserving their meaning. New DBs never hit this path — BOOTSTRAP_SQL declares them.
 */
function migrateDiceRollsTableForKeepDrop(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dice_rolls'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(dice_rolls)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('kept')) sqlite.exec('ALTER TABLE dice_rolls ADD COLUMN kept TEXT');
  if (!has('label')) sqlite.exec('ALTER TABLE dice_rolls ADD COLUMN label TEXT');
  if (!has('dc')) sqlite.exec('ALTER TABLE dice_rolls ADD COLUMN dc INTEGER');
}

/**
 * Migration for DBs created before compound dice expressions (issue #536): `dice_rolls`
 * gained `terms` (JSON of the per-term breakdown). Plain nullable ADD COLUMN — no table
 * rebuild needed, same shape as migrateDiceRollsTableForKeepDrop above. Existing rolls
 * get NULL (== a classic single-term roll, no breakdown), preserving their meaning. New
 * DBs never hit this path — BOOTSTRAP_SQL declares the column.
 */
function migrateDiceRollsTableForTerms(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dice_rolls'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(dice_rolls)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('terms')) sqlite.exec('ALTER TABLE dice_rolls ADD COLUMN terms TEXT');
}

/**
 * Migration for DBs created before physical/manual roll provenance (issue #673):
 * `dice_rolls` gained `source` (rolled|manual), optional `actor`, and optional `natural20`.
 * Existing rows default to `rolled` — their meaning is unchanged.
 */
function migrateDiceRollsTableForManualProvenance(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dice_rolls'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(dice_rolls)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('source')) sqlite.exec("ALTER TABLE dice_rolls ADD COLUMN source TEXT NOT NULL DEFAULT 'rolled'");
  if (!has('actor')) sqlite.exec('ALTER TABLE dice_rolls ADD COLUMN actor TEXT');
  if (!has('natural20')) sqlite.exec('ALTER TABLE dice_rolls ADD COLUMN natural20 INTEGER');
}

/**
 * Migration for DBs created before trash consistency (issue #701): factions,
 * story_arcs, story_beats, and encounters gained the same nullable `deleted_at`
 * timestamp the other trashable entities carry. Idempotent per-table ADD COLUMNs.
 */
function migrateTrashSoftDeleteColumns701(sqlite: Database.Database): void {
  const addDeletedAt = (table: string): void => {
    const exists = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) return;
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'deleted_at')) return;
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
  };
  for (const table of ['factions', 'story_arcs', 'story_beats', 'encounters']) {
    addDeletedAt(table);
  }
}

/**
 * Migration for DBs created before soft-delete / trash (issue #116): the trashable
 * entities gained a nullable `deleted_at` timestamp — NULL means live, an ISO string
 * means the row is in the trash (excluded from normal reads, restorable). Idempotent
 * per-table PRAGMA-guarded ADD COLUMNs. Existing rows come in with NULL (== live).
 */
function migrateSoftDeleteColumns(sqlite: Database.Database): void {
  const addDeletedAt = (table: string): void => {
    const exists = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) return; // fresh DB — BOOTSTRAP_SQL creates it with the column.
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'deleted_at')) return;
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
  };
  for (const table of ['campaigns', 'quests', 'npcs', 'locations', 'sessions', 'notes', 'characters', 'timeline_events']) {
    addDeletedAt(table);
  }
}

/**
 * Migration for DBs created before comment tombstoning (issue #503): the comments
 * table gained `deleted_at` (nullable ISO timestamp — a tombstoned root keeps its
 * row so replies survive) and `deleted_by` (the actor who tombstoned it, same
 * identity space as author_user_id). Plain nullable ADD COLUMNs — no table rebuild
 * needed, same idempotent shape as migrateSoftDeleteColumns / migrateNotesTableForRecipient
 * above. Existing comments come in with both NULL (== live), which is exactly the
 * pre-migration state. New DBs never hit this path — BOOTSTRAP_SQL already declares
 * both columns.
 *
 * Note this is deliberately NOT part of migrateSoftDeleteColumns (0031): that
 * migration predates comments' tombstone semantics, and comments are NOT filtered
 * out of normal reads the way the trashed entities are (a tombstoned root must stay
 * visible as a placeholder so replies keep their parent), so the column deserves its
 * own documented migration rather than being silently lumped into the trash set.
 */
function migrateCommentsTableForSoftDelete(sqlite: Database.Database): void {
  const hasCommentsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'")
    .get();
  if (!hasCommentsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('deleted_at')) sqlite.exec('ALTER TABLE comments ADD COLUMN deleted_at TEXT');
  if (!has('deleted_by')) sqlite.exec('ALTER TABLE comments ADD COLUMN deleted_by TEXT');
}

/**
 * Migration for DBs created before comment editor provenance (issue #783): the
 * comments table gained `edited_at` + `edited_by` (nullable), stamped ONLY when a
 * non-author (a DM moderating) edits another member's comment so the original
 * author is never the apparent writer of rewritten prose. Plain nullable ADD
 * COLUMNs — no table rebuild, same idempotent shape as the soft-delete migration
 * above. Existing rows come in with both NULL (== self-authored / never edited by
 * anyone else), which is exactly the pre-migration state. New DBs never hit this
 * path — BOOTSTRAP_SQL already declares both columns.
 *
 * Deliberately separate from 0045_comments_soft_delete: that migration predates
 * this trust fix and the two address distinct concerns (tombstone lifecycle vs.
 * honest edit attribution). Keeping them as their own recorded, idempotent steps
 * means an operator reading the migration log can tell the two apart.
 */
function migrateCommentsTableForEditorProvenance(sqlite: Database.Database): void {
  const hasCommentsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'")
    .get();
  if (!hasCommentsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('edited_at')) sqlite.exec('ALTER TABLE comments ADD COLUMN edited_at TEXT');
  if (!has('edited_by')) sqlite.exec('ALTER TABLE comments ADD COLUMN edited_by TEXT');
}

/**
 * Issue #787: persist the speaking character as immutable historical display
 * metadata while retaining the account author columns. Nullable ADD COLUMNs keep
 * legacy/OOC comments valid; old `in_character=1` rows remain honest legacy posts
 * with no invented character identity.
 */
function migrateCommentsTableForCharacterAttribution(sqlite: Database.Database): void {
  const hasCommentsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'")
    .get();
  if (!hasCommentsTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('character_id')) sqlite.exec('ALTER TABLE comments ADD COLUMN character_id INTEGER');
  if (!has('character_name')) sqlite.exec('ALTER TABLE comments ADD COLUMN character_name TEXT');
  if (!has('character_avatar_url')) sqlite.exec('ALTER TABLE comments ADD COLUMN character_avatar_url TEXT');
}

/**
 * Migration for DBs created before the VTT grid + fog of war (issue #40, phases 2–3):
 * `encounters` gained `grid_size` / `grid_scale` / `grid_unit` / `grid_snap` / `fog`.
 * Plain nullable/defaulted ADD COLUMNs. Existing encounters get NULL grid (no grid) and
 * NULL fog (fully visible), preserving the issue-#39 battle-map behaviour.
 */
function migrateEncountersTableForVtt(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('grid_size')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_size REAL');
  if (!has('grid_scale')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_scale REAL');
  if (!has('grid_unit')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_unit TEXT');
  if (!has('grid_snap')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_snap INTEGER NOT NULL DEFAULT 0');
  if (!has('fog')) sqlite.exec('ALTER TABLE encounters ADD COLUMN fog TEXT');
}

/**
 * Migration for DBs created before token size categories (issue #40, phase 2):
 * `combatants.token_size` (NOT NULL DEFAULT 'medium'). Existing rows backfill to 'medium'.
 */
function migrateCombatantsTableForTokenSize(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'token_size')) return;
  sqlite.exec("ALTER TABLE combatants ADD COLUMN token_size TEXT NOT NULL DEFAULT 'medium'");
}

/**
 * Adds `combatants.npc_id` (nullable) so a combatant of kind='npc' can link back to
 * the campaign NPC it represents (identity/icon). A plain ADD COLUMN can't attach the
 * inline `REFERENCES npcs(id)` FK on an existing table — the FK exists only for fresh
 * DBs via BOOTSTRAP_SQL, exactly as character_id/rule_entry_id already do.
 */
function migrateCombatantsTableForNpcId(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'npc_id')) return;
  sqlite.exec('ALTER TABLE combatants ADD COLUMN npc_id INTEGER');
}

/**
 * Migration for DBs created before hex grids + shared AoE templates (issue #238):
 * `encounters` gained `grid_type` (NOT NULL DEFAULT 'square' — existing encounters backfill to
 * the classic square grid) and `aoe` (nullable JSON AoeTemplate[] blob, null = no templates).
 * Plain ADD COLUMNs, same shape as migrateEncountersTableForVtt above.
 */
function migrateEncountersTableForAoeHex(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('grid_type')) sqlite.exec("ALTER TABLE encounters ADD COLUMN grid_type TEXT NOT NULL DEFAULT 'square'");
  if (!has('aoe')) sqlite.exec('ALTER TABLE encounters ADD COLUMN aoe TEXT');
}

/**
 * Migration for DBs created before grid calibration (issue #417): `encounters` gained
 * `grid_offset_x` / `grid_offset_y` / `grid_rotation` / `grid_opacity` (NOT NULL with
 * defaults that reproduce the classic top-left square grid) and the nullable
 * `grid_cell_height` (null = square cells, same as grid_size). Plain ADD COLUMNs — same
 * shape as migrateEncountersTableForVtt / migrateEncountersTableForAoeHex above. Existing
 * encounters backfill to the defaults, so their overlay is byte-for-byte unchanged.
 */
function migrateEncountersTableForGridCalibration(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('grid_offset_x')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_offset_x REAL NOT NULL DEFAULT 0');
  if (!has('grid_offset_y')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_offset_y REAL NOT NULL DEFAULT 0');
  if (!has('grid_cell_height')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_cell_height REAL');
  if (!has('grid_rotation')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_rotation REAL NOT NULL DEFAULT 0');
  if (!has('grid_opacity')) sqlite.exec('ALTER TABLE encounters ADD COLUMN grid_opacity REAL NOT NULL DEFAULT 0.35');
}

/**
 * Migration for DBs created before hex orientation (issue #467): `encounters` gained
 * `hex_orientation` (NOT NULL DEFAULT 'pointy' — existing hex grids keep pointy-top).
 */
function migrateEncountersTableForHexOrientation(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('hex_orientation')) {
    sqlite.exec("ALTER TABLE encounters ADD COLUMN hex_orientation TEXT NOT NULL DEFAULT 'pointy'");
  }
}

/**
 * Migration for DBs created before the optional DM-gated progression flag (issue #270):
 * `campaigns.dm_controls_progression` didn't exist. Plain NOT NULL DEFAULT 0 ADD COLUMN —
 * existing campaigns get 0 (false), preserving the pre-migration behavior where any
 * character owner may self-award XP / level up. A DM opts a campaign into DM-only
 * progression by setting the flag. Same idempotent shape as the ADD COLUMN migrations above.
 */
function migrateCampaignsTableForDmControlsProgression(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'dm_controls_progression')) return;

  sqlite.exec('ALTER TABLE campaigns ADD COLUMN dm_controls_progression INTEGER NOT NULL DEFAULT 0');
}

/**
 * Migration for DBs created before encounter-level secrecy (issue #262): `encounters.hidden`
 * didn't exist. Plain NOT NULL DEFAULT 0 ADD COLUMN — no table rebuild needed, same shape as
 * migrateQuestsTableForHidden / migrateNpcsTableForHidden above. Existing encounters get 0
 * (visible), preserving the pre-migration behavior where every member could read a preparing
 * encounter's roster + difficulty; a DM retroactively hides prep material by patching hidden=true.
 * New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateEncountersTableForHidden(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'hidden')) return;

  sqlite.exec('ALTER TABLE encounters ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}

function migrateEncountersTableForAftermathDismissed(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'aftermath_dismissed_at')) return;

  sqlite.exec('ALTER TABLE encounters ADD COLUMN aftermath_dismissed_at TEXT');
}

/** Boss-fight turn scheduling — lair slot at initiative 20 (issue #618). */
function migrateEncountersTableForBossTurnPhase(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('turn_phase')) sqlite.exec("ALTER TABLE encounters ADD COLUMN turn_phase TEXT NOT NULL DEFAULT 'combatant'");
  if (!has('lair_resume_combatant_id')) sqlite.exec('ALTER TABLE encounters ADD COLUMN lair_resume_combatant_id INTEGER');
}

/**
 * Migration for DBs created before first-class factions (issue #221): `npcs.faction_id`
 * didn't exist. Plain nullable ADD COLUMN — no table rebuild needed, same shape as
 * migrateLocationsTableForParentId above. The `factions` table itself is created by
 * BOOTSTRAP_SQL's CREATE TABLE IF NOT EXISTS on every boot, so no migration is needed
 * for it. Existing NPCs get NULL (no faction), preserving the pre-migration behavior;
 * the DM opts an NPC into a faction by setting factionId. The declared REFERENCES clause
 * is omitted here (added only for fresh DBs via bootstrap) per the #69 convention —
 * SQLite cannot ADD a foreign key to an existing table. New DBs never hit this path.
 */
function migrateNpcsTableForFactionId(sqlite: Database.Database): void {
  const hasNpcsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='npcs'")
    .get();
  if (!hasNpcsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(npcs)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'faction_id')) return;

  sqlite.exec('ALTER TABLE npcs ADD COLUMN faction_id INTEGER');
}

/**
 * Migration for DBs created before story beats linked to the play record (issue #264):
 * `story_beats.session_id` / `quest_id` / `encounter_id` didn't exist. Plain nullable ADD
 * COLUMNs — same shape as migrateEncountersTableForLinks above. Existing beats get NULL (no
 * link), preserving the pre-migration behavior where a beat was a planning-only note; a DM
 * records where a beat landed by setting the links. The declared REFERENCES clauses are
 * omitted here (added only for fresh DBs via bootstrap) per the #69 convention — SQLite
 * cannot ADD a foreign key to an existing table. New DBs never hit this path — BOOTSTRAP_SQL
 * already declares the columns.
 */
function migrateStoryBeatsTableForLinks(sqlite: Database.Database): void {
  const hasStoryBeatsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='story_beats'")
    .get();
  if (!hasStoryBeatsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(story_beats)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('session_id')) sqlite.exec('ALTER TABLE story_beats ADD COLUMN session_id INTEGER');
  if (!has('quest_id')) sqlite.exec('ALTER TABLE story_beats ADD COLUMN quest_id INTEGER');
  if (!has('encounter_id')) sqlite.exec('ALTER TABLE story_beats ADD COLUMN encounter_id INTEGER');
}

/**
 * Migration for DBs created before NPCs could carry a bundled entity icon (issue
 * #302): `npcs.icon_slug` didn't exist. Plain ADD COLUMN with a '' default — same
 * shape as migrateNpcsTableForFactionId above. Existing NPCs get '' (no icon),
 * preserving the pre-migration behavior where an NPC rendered as an initials
 * avatar; a DM opts an NPC into an icon by picking one. New DBs never hit this
 * path — BOOTSTRAP_SQL already declares the column.
 */
function migrateNpcsTableForIconSlug(sqlite: Database.Database): void {
  const hasNpcsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='npcs'")
    .get();
  if (!hasNpcsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(npcs)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'icon_slug')) return;

  sqlite.exec("ALTER TABLE npcs ADD COLUMN icon_slug TEXT NOT NULL DEFAULT ''");
}

/**
 * Migration for DBs created before NPC portraits (issue #1320): `npcs.portrait_url`
 * didn't exist. Plain nullable ADD COLUMN — same shape as migrateNpcsTableForFactionId
 * above. Existing NPCs get NULL (no portrait), preserving the pre-migration behavior
 * where an NPC rendered an icon or initials; a DM opts an NPC into a portrait by
 * uploading one. New DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateNpcsTableForPortraitUrl(sqlite: Database.Database): void {
  const hasNpcsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='npcs'")
    .get();
  if (!hasNpcsTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(npcs)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'portrait_url')) return;

  sqlite.exec('ALTER TABLE npcs ADD COLUMN portrait_url TEXT');
}

/**
 * Migration for DBs created before faction portraits (issue #1324): `factions.portrait_url`
 * didn't exist. Plain nullable ADD COLUMN — existing factions get NULL, preserving the
 * initials fallback until a DM uploads an emblem.
 */
function migrateFactionsTableForPortraitUrl(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factions'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(factions)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'portrait_url')) return;

  sqlite.exec('ALTER TABLE factions ADD COLUMN portrait_url TEXT');
}

/**
 * Migration for DBs created before location portraits (issue #1324): `locations.portrait_url`
 * didn't exist. Plain nullable ADD COLUMN — existing locations get NULL, preserving the
 * status-colored placeholder until a DM uploads landmark art.
 */
function migrateLocationsTableForPortraitUrl(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='locations'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(locations)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'portrait_url')) return;

  sqlite.exec('ALTER TABLE locations ADD COLUMN portrait_url TEXT');
}

/**
 * Migration for DBs created before AI provider config storage (issue #310): the
 * `ai_provider_configs` table didn't exist. This is a NEW table (not an ADD COLUMN),
 * so — like the `factions` table (see migrateNpcsTableForFactionId's note) —
 * BOOTSTRAP_SQL's CREATE TABLE IF NOT EXISTS would create it on the next boot
 * regardless. It is registered as an explicit, recorded migration (issue #69) for an
 * auditable schema history and so the table exists BEFORE the bootstrap pass. Fully
 * idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS. The declared FK REFERENCES is
 * safe to include even on a fresh DB where `campaigns` doesn't exist yet — SQLite
 * resolves FK targets at write time, not CREATE TABLE time (see bootstrap.sql.ts). This
 * runs with foreign_keys OFF (openDatabase enables enforcement only afterwards), so the
 * CREATE never trips a constraint. New DBs record this as applied even though the
 * subsequent bootstrap owns the canonical DDL.
 */
function migrateAiProviderConfigTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_provider_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      base_url TEXT,
      model TEXT NOT NULL DEFAULT '',
      params TEXT NOT NULL DEFAULT '{}',
      encrypted_api_key TEXT,
      key_last4 TEXT,
      allowed_models TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_server ON ai_provider_configs(scope) WHERE scope = 'server';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_campaign ON ai_provider_configs(campaign_id) WHERE campaign_id IS NOT NULL;
  `);
}

/**
 * Migration for DBs created before compendium rule entries could carry a manual icon
 * override (issue #305): `rule_entries.icon_slug` didn't exist. Plain ADD COLUMN with a
 * '' default — same shape as migrateNpcsTableForIconSlug above. Existing entries get ''
 * (no override), so the web app keeps deriving a default icon from type/dataJson; a DM
 * opts an entry into a specific icon by picking one. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column. Adding a plain column to the FTS content
 * table doesn't touch the indexed columns (name/summary/body), so the triggers are
 * unaffected.
 */
function migrateRuleEntriesTableForIconSlug(sqlite: Database.Database): void {
  const hasRuleEntriesTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rule_entries'")
    .get();
  if (!hasRuleEntriesTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(rule_entries)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'icon_slug')) return;

  sqlite.exec("ALTER TABLE rule_entries ADD COLUMN icon_slug TEXT NOT NULL DEFAULT ''");
}

/**
 * Migration for DBs created before compendium rule entries could carry their OWN
 * per-entry license/attribution (issue #734): previously the entry's license was dropped
 * on import and the reader labelled every entry with the PACK license, losing the
 * attribution an open licence legally obliges us to show (and mislabelling mixed-license
 * packs — an OGL pack with a CC-BY spell). Four plain ADD COLUMNs with '' defaults — same
 * idiom as 0038. Existing rows get '' for each field, which callers treat as "inherit the
 * pack's value", so an upgraded server renders exactly as before until a pack is
 * reinstalled. Per migration 0050's goal in the issue ("Migrate existing rows to explicit
 * inherited/unknown provenance"), '' is the explicit inherited marker — no backfill is
 * possible since the per-entry license was never recorded. New DBs never hit this path —
 * BOOTSTRAP_SQL already declares the columns. Adding plain columns to the FTS content
 * table doesn't touch the indexed columns (name/summary/body), so the triggers are
 * unaffected.
 */
function migrateRuleEntriesTableForLicensing(sqlite: Database.Database): void {
  const hasRuleEntriesTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rule_entries'")
    .get();
  if (!hasRuleEntriesTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(rule_entries)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  // Add each missing column independently — a partially-migrated DB (unlikely but possible
  // after an interrupted upgrade) converges without re-ALTERing an existing column.
  if (!has('license')) sqlite.exec("ALTER TABLE rule_entries ADD COLUMN license TEXT NOT NULL DEFAULT ''");
  if (!has('attribution')) sqlite.exec("ALTER TABLE rule_entries ADD COLUMN attribution TEXT NOT NULL DEFAULT ''");
  if (!has('author')) sqlite.exec("ALTER TABLE rule_entries ADD COLUMN author TEXT NOT NULL DEFAULT ''");
  if (!has('source_url')) sqlite.exec("ALTER TABLE rule_entries ADD COLUMN source_url TEXT NOT NULL DEFAULT ''");
}

/** Campaign-private compendium rows and their immutable edit history (issue #741). */
function migrateCampaignHomebrew741(sqlite: Database.Database): void {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rule_entries'").get();
  if (!exists) return;
  const columns = sqlite.prepare('PRAGMA table_info(rule_entries)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('campaign_id')) sqlite.exec('ALTER TABLE rule_entries ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE');
  if (!has('rights_status')) sqlite.exec("ALTER TABLE rule_entries ADD COLUMN rights_status TEXT NOT NULL DEFAULT 'open_licensed'");
  if (!has('archived_at')) sqlite.exec('ALTER TABLE rule_entries ADD COLUMN archived_at TEXT');
  if (!has('provenance')) sqlite.exec("ALTER TABLE rule_entries ADD COLUMN provenance TEXT NOT NULL DEFAULT ''");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rule_entry_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_entry_id INTEGER NOT NULL REFERENCES rule_entries(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      actor TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    DROP INDEX IF EXISTS idx_rule_entries_pack_type_slug;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_entries_pack_type_slug ON rule_entries(pack_id, type, slug) WHERE campaign_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_entries_campaign_slug ON rule_entries(campaign_id, slug) WHERE campaign_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rule_entries_campaign ON rule_entries(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_rule_entry_revisions_entry ON rule_entry_revisions(rule_entry_id, id);
  `);
}

/**
 * Migration for DBs created before inventory items could carry a bundled entity
 * icon (issue #307): `inventory_items.icon_slug` didn't exist. Plain ADD COLUMN
 * with a '' default — same idiom as migrateNpcsTableForIconSlug (0037). Existing
 * items get '' (no override), so the UI keeps deriving a default icon from the
 * item's name/type; a DM opts an item into an explicit icon by picking one. New
 * DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateInventoryItemsTableForIconSlug(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_items'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(inventory_items)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'icon_slug')) return;

  sqlite.exec("ALTER TABLE inventory_items ADD COLUMN icon_slug TEXT NOT NULL DEFAULT ''");
}

/**
 * Migration for DBs created before inventory items could be soft-deleted (issue #551):
 * `inventory_items.deleted_at` and `inventory_items.deleted_by` didn't exist. Plain
 * nullable ADD COLUMNs — same idiom as the other soft-delete migrations (0031/0045).
 * Existing items default to NULL (live); new DBs already have the columns.
 */
function migrateInventoryItemsTableForSoftDelete(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_items'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(inventory_items)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'deleted_at')) {
    sqlite.exec('ALTER TABLE inventory_items ADD COLUMN deleted_at TEXT');
  }
  if (!columns.some((c) => c.name === 'deleted_by')) {
    sqlite.exec('ALTER TABLE inventory_items ADD COLUMN deleted_by TEXT');
  }
}

/** Issue #738: portable compendium item provenance; additive so installed alpha DBs upgrade in place. */
function migrateInventoryItemsCompendium738(sqlite: Database.Database): void {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_items'").get();
  if (!table) return;
  const columns = sqlite.prepare('PRAGMA table_info(inventory_items)').all() as Array<{ name: string }>;
  const additions: Array<[string, string]> = [
    ['rule_entry_id', 'INTEGER'], ['compendium_ref', 'TEXT'], ['compendium_snapshot', 'TEXT'], ['compendium_state', 'TEXT'],
  ];
  for (const [name, type] of additions) if (!columns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE inventory_items ADD COLUMN ${name} ${type}`);
}

/**
 * Migration for DBs created before the AI-DM operating mode (issue #311): the
 * `ai_dm_seats.mode` column didn't exist. Plain NOT NULL DEFAULT 'off' ADD COLUMN —
 * no table rebuild needed, same shape as the icon_slug migrations above. Existing
 * seats default to 'off' (no AI participation), preserving pre-migration behavior;
 * a DM opts into co_dm/driver via the AI-DM settings UI. New DBs never hit this
 * path — BOOTSTRAP_SQL already declares the column.
 */
function migrateAiDmSeatsTableForMode(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_dm_seats'")
    .get();
  if (!hasTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(ai_dm_seats)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'mode')) return;

  sqlite.exec("ALTER TABLE ai_dm_seats ADD COLUMN mode TEXT NOT NULL DEFAULT 'off'");
}

function migrateAiDmSeatsTableForActionQueueDepth(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_dm_seats'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(ai_dm_seats)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'action_queue_depth')) return;

  sqlite.exec('ALTER TABLE ai_dm_seats ADD COLUMN action_queue_depth INTEGER DEFAULT 8');
}

/**
 * Issue #1049: structured table style (tone / pacing / verbosity / combat style / NPC depth)
 * on the AI-DM seat. One JSON column rather than five scalars, matching `proactive_settings`
 * — the block is always read and written whole, and #1070's cross-campaign reuse will want to
 * copy it as one value. Defaults to '{}', which zod fills with the all-`default` preset,
 * meaning an upgraded seat renders no style section at all until a DM chooses one.
 */
function migrateAiDmSeatsTableForStylePresets1049(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_dm_seats'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(ai_dm_seats)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'style_presets')) return;

  sqlite.exec("ALTER TABLE ai_dm_seats ADD COLUMN style_presets TEXT DEFAULT '{}'");
}

function migrateAiDmSeatsTableForProactiveSettings(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_dm_seats'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(ai_dm_seats)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'proactive_settings')) return;

  sqlite.exec("ALTER TABLE ai_dm_seats ADD COLUMN proactive_settings TEXT DEFAULT '{}'");
}

/**
 * Issue #563: AI budget enforcement now reserves capacity before provider contact.
 * These counters are cumulative/active token state for upgraded seats:
 *   - tokens_reserved: currently in-flight capacity held before provider contact
 *   - tokens_refunded: unused reserved capacity returned after known usage
 *   - tokens_unknown : reserved capacity consumed by provider calls with unknown usage
 *   - tokens_overage : known usage above the pre-call reservation
 */
function migrateAiDmSeatsTableForTokenReservations(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_dm_seats'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(ai_dm_seats)').all() as Array<{ name: string }>;
  const add = (name: string) => {
    if (!columns.some((c) => c.name === name)) {
      sqlite.exec(`ALTER TABLE ai_dm_seats ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
    }
  };
  add('tokens_reserved');
  add('tokens_refunded');
  add('tokens_unknown');
  add('tokens_overage');
}

/**
 * Migration for DBs created before the AI scribe (issue #316): the
 * `ai_scribe_configs` + `ai_scribe_jobs` tables didn't exist. Like the
 * ai_provider_configs migration (0040) these are NEW tables, so BOOTSTRAP_SQL's
 * CREATE TABLE IF NOT EXISTS would create them on the next boot regardless; they
 * are registered as an explicit recorded migration for an auditable schema history
 * and so the tables exist BEFORE the bootstrap pass. Fully idempotent (CREATE TABLE
 * / CREATE INDEX IF NOT EXISTS). Runs with foreign_keys OFF, so the declared FK
 * REFERENCES campaigns(id) never trips a constraint on a fresh DB where campaigns
 * doesn't exist yet (SQLite resolves FK targets at write time, not CREATE time).
 */
function migrateAiScribeTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_scribe_configs (
      campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      post_session INTEGER NOT NULL DEFAULT 0,
      cron INTEGER NOT NULL DEFAULT 0,
      budget_per_run INTEGER NOT NULL DEFAULT 2000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_scribe_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      source_hash TEXT,
      proposal_id INTEGER,
      proposal_count INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_scribe_jobs_campaign ON ai_scribe_jobs(campaign_id, created_at);
  `);
}

/**
 * Migration for DBs created before per-turn AI usage history (issue #1060): the
 * `ai_dm_usage_history` table didn't exist. Same "new table" pattern as
 * migrateAiScribeTables — CREATE TABLE / CREATE INDEX IF NOT EXISTS, recorded so
 * upgraded hosts get the table before BOOTSTRAP_SQL runs. Rebuilds the
 * (campaign_id, created_at, id) index so ORDER BY created_at DESC, id DESC is covered.
 */
function migrateAiDmUsageHistoryTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_dm_usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      tokens_used INTEGER NOT NULL,
      action TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    DROP INDEX IF EXISTS idx_ai_dm_usage_history_campaign_created;
    CREATE INDEX IF NOT EXISTS idx_ai_dm_usage_history_campaign_created
      ON ai_dm_usage_history (campaign_id, created_at DESC, id DESC);
  `);
}

/**
 * Migration for DBs created before durable AI Driver controls (issue #559): the
 * `ai_driver_control_state` table didn't exist. New table, one row per campaign.
 */
function migrateAiDriverControlStateTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_driver_control_state (
      campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'idle',
      state TEXT NOT NULL DEFAULT 'running',
      scene TEXT,
      last_narration TEXT,
      last_turn_at TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      stuck TEXT,
      acting_dm TEXT,
      vote TEXT,
      takeover_requested_by TEXT,
      last_input TEXT,
      announced_recovery TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Backfill `announced_recovery` on `ai_driver_control_state` (issue #559).
 *
 * Deliberately its OWN migration rather than a probe bolted inside the create-table migration.
 * `runMigrations` skips any migration whose NAME is already recorded in `__migrations`, so a probe
 * living inside `migrateAiDriverControlStateTable` would never run on exactly the DBs that need
 * it — one that recorded the create against an earlier build whose CREATE lacked the column. The
 * column would stay missing, every drizzle read/write against the table would throw, and the
 * best-effort try/catch around persistence would swallow it, silently disabling restart-safety
 * with no visible symptom. An additive column change gets its own never-before-recorded name so
 * it runs independently of whether the CREATE was already recorded.
 *
 * That reachability is not hypothetical: this migration pair was renumbered several times while
 * #559 was in review as main took the ordinals underneath it, so DBs exist that recorded the
 * create under an older name and a column-less shape. Two rules follow, and they outlive whatever
 * ordinals the pair currently sits on: do NOT fold these two back into one migration, and do NOT
 * reuse any name either has previously shipped under — a name already in `__migrations` is a
 * migration that will never run again.
 */
function migrateAiDriverControlStateAnnouncedRecovery(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_driver_control_state'")
    .get();
  if (!hasTable) return;
  const cols = sqlite.prepare('PRAGMA table_info(ai_driver_control_state)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'announced_recovery')) {
    sqlite.exec('ALTER TABLE ai_driver_control_state ADD COLUMN announced_recovery TEXT');
  }
}

/**
 * Issue #1042 — two additive columns on `ai_driver_control_state` holding the AI seat's
 * outstanding GRANTS OF AUTHORITY: unconsumed secret-read approvals (#557) and queued
 * confirm-policy tool calls awaiting DM approval (#474).
 *
 * They are persisted so a restart can REVOKE THEM LOUDLY — audited, signalled, and visible in
 * the table log — not so they can be resurrected. That distinction is the whole point of the
 * issue: "silently revoked" is the bug, and you cannot audit the revocation of something you
 * kept no record of. Hydration reads these, writes one audit row per discarded grant, tells the
 * table, and clears the columns; nothing is ever restored onto the live session.
 *
 * A SEPARATE, never-before-recorded migration name rather than a widening of #559's
 * `migrateAiDriverControlStateTable`, for exactly the reason that migration's own comment
 * spells out: a database that already recorded the CREATE would never re-run it, so a column
 * folded into it would stay missing forever — and every drizzle read of the table would then
 * throw inside a best-effort try/catch that swallows it, silently disabling restart-safety with
 * no visible symptom. Additive column changes get their own name so they run independently of
 * whether the CREATE was recorded.
 *
 * Guarded per-column (not per-table): a database may legitimately have one column and not the
 * other if a future branch adds a third the same way.
 */
function migrateAiDriverSessionPersistence1042(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_driver_control_state'")
    .get();
  if (!hasTable) return;
  const cols = sqlite.prepare('PRAGMA table_info(ai_driver_control_state)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('secret_read_approvals')) {
    sqlite.exec('ALTER TABLE ai_driver_control_state ADD COLUMN secret_read_approvals TEXT');
  }
  if (!names.has('pending_tool_confirmations')) {
    sqlite.exec('ALTER TABLE ai_driver_control_state ADD COLUMN pending_tool_confirmations TEXT');
  }
}

/**
 * Issue #1043 — the AI session lifecycle phase on `ai_driver_control_state`.
 *
 * NOT NULL with a DEFAULT, which is exactly what makes the ALTER safe on a populated table:
 * SQLite backfills every existing row with 'active', and 'active' is the phase whose behaviour
 * is identical to the pre-#1043 seat. So an upgraded install with live sessions comes back
 * indistinguishable from before, rather than every campaign in the database waking up in a
 * lifecycle phase nobody put it in.
 *
 * A separate, never-before-recorded migration name rather than a widening of #559's
 * `migrateAiDriverControlStateTable`, for the reason that migration's own comment gives: a
 * database that already recorded the CREATE will never re-run it, so a column folded in there
 * would stay missing forever — and every drizzle read of the table would then throw inside the
 * best-effort try/catch that swallows it, silently disabling restart-safety with no symptom.
 */
function migrateAiDriverSessionPhase1043(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_driver_control_state'")
    .get();
  if (!hasTable) return;
  const cols = sqlite.prepare('PRAGMA table_info(ai_driver_control_state)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'phase')) {
    sqlite.exec("ALTER TABLE ai_driver_control_state ADD COLUMN phase TEXT NOT NULL DEFAULT 'active'");
  }
}

/**
 * Issue #1051 — collaborative handoff on `ai_driver_control_state`.
 *
 * NOT NULL DEFAULT 0, so SQLite backfills every existing row to "off" — which is the behaviour
 * every campaign already has. An upgraded install cannot wake up with the AI unexpectedly
 * deferring, or unexpectedly not deferring; the column is inert until a DM turns it on.
 *
 * A separate, never-before-recorded migration name rather than a widening of #559's
 * `migrateAiDriverControlStateTable`, for the reason that migration's own comment gives: a
 * database that already recorded the CREATE never re-runs it, so a column folded in there would
 * stay missing forever — and every drizzle read of the table would then throw inside the
 * best-effort try/catch that swallows it, silently disabling restart-safety with no symptom.
 */
function migrateAiDriverCollaborative1051(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_driver_control_state'")
    .get();
  if (!hasTable) return;
  const cols = sqlite.prepare('PRAGMA table_info(ai_driver_control_state)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'collaborative')) {
    sqlite.exec('ALTER TABLE ai_driver_control_state ADD COLUMN collaborative INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Migration for DBs created before DM-initiated check requests (issue #415): the
 * `check_requests` table didn't exist. Same "new table" pattern as migrateAiScribeTables —
 * CREATE TABLE / CREATE INDEX IF NOT EXISTS, recorded so upgraded hosts get the table (and its
 * indexes) before BOOTSTRAP_SQL runs. Runs with foreign_keys OFF, so the declared FK
 * REFERENCES never trips a constraint on a fresh DB where campaigns/characters don't exist yet.
 */
function migrateCheckRequestsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS check_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      encounter_id INTEGER,
      check_id TEXT NOT NULL,
      check_label TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'flat',
      dc INTEGER,
      consequence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by_user_id TEXT NOT NULL,
      requested_by_name TEXT NOT NULL DEFAULT '',
      roll_id INTEGER,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_check_requests_campaign ON check_requests(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_check_requests_character ON check_requests(character_id, status);
  `);
}

/**
 * Issue #789 — notification preferences. Four NEW tables (per-category delivery
 * mode, quiet hours, the deferred/digest queue, and the reminder/nudge dedup
 * ledger). All are plain CREATE TABLE / CREATE INDEX IF NOT EXISTS, so this is a
 * recorded no-op on fresh DBs (BOOTSTRAP_SQL already declares them) and a
 * one-time create on upgraded DBs. Mirrors bootstrap.sql.ts exactly. The
 * declared FK REFERENCES are inert at CREATE time (SQLite resolves FK targets at
 * write time) but kept identical so both paths converge on the same schema.
 */
function migrateNotificationPreferencesTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'immediate',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_user_campaign_category
      ON notification_preferences(user_id, campaign_id, category);

    CREATE TABLE IF NOT EXISTS notification_quiet_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      start_minute INTEGER NOT NULL DEFAULT 1320,
      end_minute INTEGER NOT NULL DEFAULT 420,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_quiet_hours_user_campaign
      ON notification_quiet_hours(user_id, campaign_id);

    CREATE TABLE IF NOT EXISTS notification_digest_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      entity_type TEXT,
      entity_id INTEGER,
      comment_id INTEGER,
      data TEXT,
      actor_name TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT 'digest',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_digest_queue_campaign
      ON notification_digest_queue(campaign_id, user_id);

    CREATE TABLE IF NOT EXISTS notification_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_session_id INTEGER NOT NULL REFERENCES scheduled_sessions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_reminders_session_user_kind
      ON notification_reminders(scheduled_session_id, user_id, kind);
  `);
}

/**
 * Issue #849: campaign_members.user_id used to be an unconstrained integer, so
 * a typo or stale import could create a "ghost" DM that could never authenticate
 * but still defeated the last-DM guard. SQLite cannot ALTER-ADD a foreign key,
 * therefore upgraded databases use a transactional table rebuild.
 *
 * Unsafe legacy rows are handled before constraints become active:
 *  - a missing user or campaign removes the meaningless membership;
 *  - a missing character clears only that optional link;
 *  - every repair is recorded as identifier/role metadata (no campaign body or
 *    secrets) in membership_integrity_repairs for operator diagnosis.
 *
 * The rebuilt table carries the complete modern FK set, not only the new user
 * FK, so fresh and upgraded databases have the same schema. Migrations run while
 * foreign_keys is OFF and the entire copy/drop/rename sequence is one SQLite
 * transaction, so a failure leaves the original table untouched.
 */
function migrateCampaignMembersTableForUserFk(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS membership_integrity_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      reason TEXT NOT NULL,
      action TEXT NOT NULL,
      invalid_reference_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(member_id, reason)
    );
  `);

  const hasMembersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_members'")
    .get();
  if (!hasMembersTable) return; // fresh DB — BOOTSTRAP_SQL creates the constrained table.

  const foreignKeys = sqlite.pragma('foreign_key_list(campaign_members)') as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
  const hasUserCascade = foreignKeys.some(
    (fk) => fk.table === 'users' && fk.from === 'user_id' && fk.on_delete.toUpperCase() === 'CASCADE',
  );
  if (hasUserCascade) return;

  const repairedAt = new Date().toISOString();
  const migrate = sqlite.transaction(() => {
    sqlite
      .prepare(`
        INSERT OR IGNORE INTO membership_integrity_repairs
          (campaign_id, member_id, user_id, role, reason, action, invalid_reference_id, created_at)
        SELECT cm.campaign_id, cm.id, cm.user_id, cm.role,
               'missing_user', 'removed_membership', cm.user_id, ?
        FROM campaign_members cm
        LEFT JOIN users u ON u.id = cm.user_id
        WHERE u.id IS NULL
      `)
      .run(repairedAt);

    sqlite
      .prepare(`
        INSERT OR IGNORE INTO membership_integrity_repairs
          (campaign_id, member_id, user_id, role, reason, action, invalid_reference_id, created_at)
        SELECT cm.campaign_id, cm.id, cm.user_id, cm.role,
               'missing_campaign', 'removed_membership', cm.campaign_id, ?
        FROM campaign_members cm
        JOIN users u ON u.id = cm.user_id
        LEFT JOIN campaigns c ON c.id = cm.campaign_id
        WHERE c.id IS NULL
      `)
      .run(repairedAt);

    sqlite
      .prepare(`
        INSERT OR IGNORE INTO membership_integrity_repairs
          (campaign_id, member_id, user_id, role, reason, action, invalid_reference_id, created_at)
        SELECT cm.campaign_id, cm.id, cm.user_id, cm.role,
               'missing_character', 'cleared_character', cm.character_id, ?
        FROM campaign_members cm
        JOIN users u ON u.id = cm.user_id
        JOIN campaigns c ON c.id = cm.campaign_id
        LEFT JOIN characters ch ON ch.id = cm.character_id
        WHERE cm.character_id IS NOT NULL AND ch.id IS NULL
      `)
      .run(repairedAt);

    sqlite.exec(`
      CREATE TABLE campaign_members_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, user_id)
      );

      INSERT INTO campaign_members_new
        (id, campaign_id, user_id, role, character_id, created_at, updated_at)
      SELECT cm.id, cm.campaign_id, cm.user_id, cm.role,
             CASE WHEN ch.id IS NULL THEN NULL ELSE cm.character_id END,
             cm.created_at, cm.updated_at
      FROM campaign_members cm
      JOIN users u ON u.id = cm.user_id
      JOIN campaigns c ON c.id = cm.campaign_id
      LEFT JOIN characters ch ON ch.id = cm.character_id;

      DROP TABLE campaign_members;
      ALTER TABLE campaign_members_new RENAME TO campaign_members;
    `);
  });
  migrate();
}

/**
 * Migration for issue #749: combatants previously had only a plain
 * (encounter_id) index, so nothing at the DB boundary stopped two concurrent
 * `addCombatant` calls from inserting the same character/NPC twice — the
 * service layer's SELECT-then-INSERT probe is a TOCTOU race. The fix adds two
 * partial UNIQUE indexes (one per non-NULL identity column), declared in
 * BOOTSTRAP_SQL so fresh DBs get them automatically. This migration:
 *
 *   1. Collapses any pre-existing duplicate (encounter_id, character_id) /
 *      (encounter_id, npc_id) rows (keeping the lowest id), so the partial
 *      unique indexes can be CREATED on an upgraded DB without throwing. Live
 *      duplicates were only ever reachable through the very race this fixes
 *      (or a hand-edited DB), so the "keep earliest" policy matches how the
 *      rule_entries dedupe migration (0027) handled its pre-index duplicates.
 *   2. Creates the two partial unique indexes idempotently. BOOTSTRAP_SQL also
 *      declares them (CREATE ... IF NOT EXISTS), so this step just makes sure
 *      they exist before bootstrap runs on an upgraded DB that already had the
 *      combatants table; on a fresh DB the migration is a no-op and bootstrap
 *      owns the canonical DDL.
 *
 * Runs with foreign_keys OFF (the default at open time), same as every other
 * migration. New DBs never hit the dedupe DELETE (the table is empty) and
 * record this migration as applied without doing any real work.
 */
function migrateCombatantsUniqueIdentity(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return; // fresh DB — BOOTSTRAP_SQL creates the table + indexes.

  // Before collapsing duplicates, repoint encounters.current_combatant_id away
  // from any combatant row we are ABOUT to delete, so turn tracking does not end
  // up dangling. For each identity we keep MIN(id) per (encounter, identity); any
  // to-be-deleted duplicate whose id is the encounter's current pointer is
  // remapped to that surviving id. Migrations run with foreign_keys OFF, so
  // without this repoint the FK would dangle (and on fresh-DB shapes where the FK
  // is enforced, the post-migrate foreign-key check would flag it).
  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  const hasNpcId = columns.some((c) => c.name === 'npc_id');
  const hasCurrentPointer =
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
      .get() !== undefined &&
    (sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>).some(
      (c) => c.name === 'current_combatant_id',
    );
  if (hasCurrentPointer) {
    const remapForIdentity = (identityCol: 'character_id' | 'npc_id') => {
      // For each (encounter, identity) group that has duplicates, repoint the
      // encounter's current_combatant_id to the surviving MIN(id) ONLY when the
      // pointer currently references one of the duplicate (to-be-deleted) rows
      // for THAT identity — i.e. a row whose id differs from keep_id but shares
      // keep_id's identity value. A pointer at an unrelated combatant (a monster,
      // or a different identity) is left untouched, so the turn pointer is never
      // collateral-damaged by an unrelated group's dedupe.
      const survivors = sqlite
        .prepare(
          `SELECT encounter_id, ${identityCol} AS identity_value, MIN(id) AS keep_id
           FROM combatants WHERE ${identityCol} IS NOT NULL
           GROUP BY encounter_id, ${identityCol}
           HAVING COUNT(*) > 1`,
        )
        .all() as Array<{ encounter_id: number; identity_value: number; keep_id: number }>;
      for (const { encounter_id, identity_value, keep_id } of survivors) {
        sqlite
          .prepare(
            `UPDATE encounters
               SET current_combatant_id = ?
             WHERE id = ?
               AND current_combatant_id IS NOT NULL
               AND current_combatant_id != ?
               AND current_combatant_id IN (
                 SELECT id FROM combatants
                 WHERE encounter_id = ? AND ${identityCol} = ?
               )`,
          )
          .run(keep_id, encounter_id, keep_id, encounter_id, identity_value);
      }
    };
    remapForIdentity('character_id');
    if (hasNpcId) remapForIdentity('npc_id');
  }

  // Collapse exact (encounter_id, character_id) duplicates, keeping the earliest
  // row. character_id IS NULL rows are left alone (the partial index ignores them
  // anyway, and "duplicate monster" rows are legitimate — three Goblins, #114).
  sqlite.exec(`
    DELETE FROM combatants
    WHERE character_id IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id) FROM combatants WHERE character_id IS NOT NULL GROUP BY encounter_id, character_id
      );
  `);
  // Same dedupe for NPC identity. npc_id may not exist on the oldest DBs
  // (migration 0044 adds it), but by the time this runs 0044 has already applied,
  // so the column is present on every table that survived to this point.
  if (hasNpcId) {
    sqlite.exec(`
      DELETE FROM combatants
      WHERE npc_id IS NOT NULL
        AND id NOT IN (
          SELECT MIN(id) FROM combatants WHERE npc_id IS NOT NULL GROUP BY encounter_id, npc_id
        );
    `);
  }

  // Idempotent partial unique indexes. These match the BOOTSTRAP_SQL declarations
  // exactly (same names) so a subsequent boot's CREATE ... IF NOT EXISTS is a no-op.
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_combatants_encounter_character
      ON combatants(encounter_id, character_id) WHERE character_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_combatants_encounter_npc
      ON combatants(encounter_id, npc_id) WHERE npc_id IS NOT NULL;
  `);
}

/**
 * Issue #788: privacy metadata and policy for public recap capabilities.
 * Existing links were created without an explicit "never" decision, so the
 * upgrade gives them a conservative seven-day sunset. A deliberately never-
 * expiring link created after the migration is represented by NULL and is not
 * touched again because this named migration runs only once.
 */
function migratePublicRecapSharePolicy(sqlite: Database.Database): void {
  const cutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const migrate = sqlite.transaction(() => {
    const hasCampaigns = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
    if (hasCampaigns) {
      const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'public_recap_sharing_enabled')) {
        sqlite.exec('ALTER TABLE campaigns ADD COLUMN public_recap_sharing_enabled INTEGER NOT NULL DEFAULT 1');
      }
    }

    const hasShares = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_shares'").get();
    if (!hasShares) return;
    const columns = sqlite.prepare('PRAGMA table_info(session_shares)').all() as Array<{ name: string }>;
    const has = (name: string) => columns.some((column) => column.name === name);
    const legacyNeedsExpiry = !has('expires_at');
    if (!has('label')) sqlite.exec("ALTER TABLE session_shares ADD COLUMN label TEXT NOT NULL DEFAULT ''");
    if (legacyNeedsExpiry) sqlite.exec('ALTER TABLE session_shares ADD COLUMN expires_at TEXT');
    if (!has('access_count')) sqlite.exec('ALTER TABLE session_shares ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0');
    if (!has('first_accessed_at')) sqlite.exec('ALTER TABLE session_shares ADD COLUMN first_accessed_at TEXT');
    if (!has('last_accessed_at')) sqlite.exec('ALTER TABLE session_shares ADD COLUMN last_accessed_at TEXT');
    if (legacyNeedsExpiry) sqlite.prepare('UPDATE session_shares SET expires_at = ? WHERE expires_at IS NULL').run(cutoff);

    // Pre-#788 rows stored a numeric actor id. Recover a useful member-facing
    // creator label where the corresponding user still exists; audit rows keep
    // the immutable actor identity either way.
    sqlite.exec(`
      UPDATE session_shares
      SET created_by = COALESCE(
        (SELECT NULLIF(users.display_name, '') FROM users WHERE CAST(users.id AS TEXT) = session_shares.created_by),
        (SELECT users.username FROM users WHERE CAST(users.id AS TEXT) = session_shares.created_by),
        created_by
      )
      WHERE created_by <> '' AND created_by NOT GLOB '*[^0-9]*';
    `);
  });
  migrate();
}

/**
 * Issue #857: campaign-level public-invite kill switch. Existing *active* campaigns
 * keep invites enabled (DEFAULT 1) so live tables are uninterrupted; paused/
 * completed/trashed rows are cleared immediately so restore after upgrade cannot
 * accidentally revive bearer join links (see also 0059 for DBs that already ran
 * an earlier 0058 that only ADDed the column).
 */
function migrateCampaignsTableForPublicInvitesEnabled(sqlite: Database.Database): void {
  const hasCampaigns = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
  if (!hasCampaigns) return;
  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'public_invites_enabled')) return;
  sqlite.exec('ALTER TABLE campaigns ADD COLUMN public_invites_enabled INTEGER NOT NULL DEFAULT 1');
  // Soft-delete (0031) runs before this migration, so deleted_at is present.
  sqlite.exec(`
    UPDATE campaigns
    SET public_invites_enabled = 0
    WHERE status IN ('paused', 'completed')
       OR deleted_at IS NOT NULL
  `);
}

/**
 * Issue #857 follow-up: 0058 originally ADDed `public_invites_enabled` DEFAULT 1
 * without clearing paused/completed/trashed rows. DBs that already applied that
 * shape would restore those campaigns with invites still enabled. Clear the flag
 * for any non-live campaign so restore matches the suspend-on-archive contract.
 * Idempotent: re-running on an already-cleared DB is a no-op UPDATE.
 */
function migratePublicInvitesDisabledForInactiveCampaigns(sqlite: Database.Database): void {
  const hasCampaigns = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
  if (!hasCampaigns) return;
  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'public_invites_enabled')) return;
  sqlite.exec(`
    UPDATE campaigns
    SET public_invites_enabled = 0
    WHERE public_invites_enabled != 0
      AND (
        status IN ('paused', 'completed')
        OR deleted_at IS NOT NULL
      )
  `);
}

/**
 * Migration for issue #723 (PWA restore safety): the `server_meta` table didn't
 * exist before install/data-generation identity was tracked. The table itself is
 * a single-row singleton (key='singleton') carrying a per-install UUID and a
 * monotonic `data_generation` bumped on every whole-server restore — see
 * ServerMetaService. CREATE TABLE IF NOT EXISTS is fully idempotent, and a fresh
 * DB never hits this path because BOOTSTRAP_SQL already declares the table. Runs
 * with foreign_keys OFF (no FK constraints here regardless), same as the other
 * new-table migrations above (e.g. 0040 ai_provider_config).
 */
function migrateServerMetaTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS server_meta (
      key TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      data_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Issue #864: encounter create historically accepted arbitrary location/quest/session
 * ids without checking they belong to the encounter's campaign. SQLite FKs only prove
 * the target ROW exists — not that its campaign_id matches — so cross-campaign links
 * could persist. This repair nullifies any location_id / quest_id / session_id whose
 * target is missing or owned by a different campaign. Valid same-campaign links are
 * untouched. Idempotent: a second run finds nothing left to clear. Fresh DBs never
 * hit real work (encounters table absent during early migration pass; bootstrap then
 * creates a clean schema, and create() now validates before insert).
 */
function migrateEncounterLinksCampaignScope(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (!hasEncountersTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  // Pre-0019 DBs may lack some/all link columns. Repair whichever exist —
  // each UPDATE below is independently gated on its column.
  if (!has('location_id') && !has('quest_id') && !has('session_id')) return;

  const hasLocations = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='locations'").get();
  const hasQuests = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quests'").get();
  const hasSessions = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();

  // Clear each link independently so a single bad field never wipes the other two
  // valid attachments on the same encounter. When the target table is absent we
  // cannot prove campaign ownership — nullify those links so stale ids do not linger.
  if (has('location_id')) {
    if (hasLocations) {
      sqlite.exec(`
        UPDATE encounters
        SET location_id = NULL
        WHERE location_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM locations
            WHERE locations.id = encounters.location_id
              AND locations.campaign_id = encounters.campaign_id
          )
      `);
    } else {
      sqlite.exec(`UPDATE encounters SET location_id = NULL WHERE location_id IS NOT NULL`);
    }
  }
  if (has('quest_id')) {
    if (hasQuests) {
      sqlite.exec(`
        UPDATE encounters
        SET quest_id = NULL
        WHERE quest_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM quests
            WHERE quests.id = encounters.quest_id
              AND quests.campaign_id = encounters.campaign_id
          )
      `);
    } else {
      sqlite.exec(`UPDATE encounters SET quest_id = NULL WHERE quest_id IS NOT NULL`);
    }
  }
  if (has('session_id')) {
    if (hasSessions) {
      sqlite.exec(`
        UPDATE encounters
        SET session_id = NULL
        WHERE session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE sessions.id = encounters.session_id
              AND sessions.campaign_id = encounters.campaign_id
          )
      `);
    } else {
      sqlite.exec(`UPDATE encounters SET session_id = NULL WHERE session_id IS NOT NULL`);
    }
  }
}

/**
 * Issue #813: entity_revisions historically snapshotted prior prose while stamping
 * the REPLACING editor as `author_*` / `created_at`, so the archive attributed old
 * canon to the person who overwrote it. Add version-vs-replacer columns and migrate
 * existing rows into the honest legacy shape: author fields cleared, authorship_known=0,
 * and the old author/time moved onto replaced_by_* / replaced_at so the UI can label
 * them "Replaced by Bob at…" rather than inventing an author. Fresh DBs never hit this
 * path — BOOTSTRAP_SQL already declares the modern columns.
 */
function migrateEntityRevisionsForVersionAuthorship(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_revisions'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(entity_revisions)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  // Only backfill when this run is the one that introduces the replacer columns —
  // every row present at that moment is pre-#813. Re-running later must not touch
  // current tips (replaced_at IS NULL with real authorship).
  const needsLegacyBackfill = !has('replaced_at') || !has('authorship_known');

  if (!has('author_source')) sqlite.exec("ALTER TABLE entity_revisions ADD COLUMN author_source TEXT NOT NULL DEFAULT 'human'");
  if (!has('author_source_detail')) {
    sqlite.exec("ALTER TABLE entity_revisions ADD COLUMN author_source_detail TEXT NOT NULL DEFAULT ''");
  }
  if (!has('replaced_by_user_id')) {
    sqlite.exec("ALTER TABLE entity_revisions ADD COLUMN replaced_by_user_id TEXT NOT NULL DEFAULT ''");
  }
  if (!has('replaced_by_name')) {
    sqlite.exec("ALTER TABLE entity_revisions ADD COLUMN replaced_by_name TEXT NOT NULL DEFAULT ''");
  }
  if (!has('replaced_by_source')) {
    sqlite.exec("ALTER TABLE entity_revisions ADD COLUMN replaced_by_source TEXT NOT NULL DEFAULT 'human'");
  }
  if (!has('replaced_by_source_detail')) {
    sqlite.exec("ALTER TABLE entity_revisions ADD COLUMN replaced_by_source_detail TEXT NOT NULL DEFAULT ''");
  }
  if (!has('replaced_at')) sqlite.exec('ALTER TABLE entity_revisions ADD COLUMN replaced_at TEXT');
  if (!has('restored_from_revision_id')) {
    sqlite.exec('ALTER TABLE entity_revisions ADD COLUMN restored_from_revision_id INTEGER');
  }
  if (!has('authorship_known')) {
    sqlite.exec('ALTER TABLE entity_revisions ADD COLUMN authorship_known INTEGER NOT NULL DEFAULT 1');
  }

  if (!needsLegacyBackfill) return;

  // Pre-#813 rows stamped the replacing editor as author/created_at. Move those
  // onto the replacer fields and clear version authorship so the UI can say
  // "Replaced by …" instead of inventing an author.
  sqlite.exec(`
    UPDATE entity_revisions
    SET
      replaced_by_user_id = author_user_id,
      replaced_by_name = author_name,
      replaced_by_source = CASE
        WHEN author_source IS NULL OR author_source = '' THEN 'human'
        ELSE author_source
      END,
      replaced_by_source_detail = COALESCE(author_source_detail, ''),
      replaced_at = created_at,
      author_user_id = '',
      author_name = '',
      author_source = 'human',
      author_source_detail = '',
      created_at = '',
      authorship_known = 0
  `);
}

/**

 * Issue #679: retain consumed refresh-token generations as replay sentinels and
 * link rotations into a revocable family. Existing live rows each become the
 * root of their own family, preserving every issued token while allowing the
 * first post-upgrade rotation to use the same atomic CAS path as new grants.
 */
function migrateOAuthAccessTokensForAtomicRotation(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_access_tokens'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(oauth_access_tokens)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((column) => column.name === name);
  const migrate = sqlite.transaction(() => {
    if (!has('family_id')) sqlite.exec('ALTER TABLE oauth_access_tokens ADD COLUMN family_id TEXT');
    if (!has('refresh_consumed_at')) sqlite.exec('ALTER TABLE oauth_access_tokens ADD COLUMN refresh_consumed_at TEXT');
    if (!has('revoked_at')) sqlite.exec('ALTER TABLE oauth_access_tokens ADD COLUMN revoked_at TEXT');
    if (!has('family_revoked_at')) sqlite.exec('ALTER TABLE oauth_access_tokens ADD COLUMN family_revoked_at TEXT');
    sqlite.exec("UPDATE oauth_access_tokens SET family_id = 'legacy-' || id WHERE family_id IS NULL");
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_family ON oauth_access_tokens(family_id)');
  });
  migrate();
}

/**
 * Migration for DBs created before combat-log combatant ids (issue #869):
 * `encounter_events.actor_id` / `target_id` didn't exist. Plain nullable ADD
 * COLUMNs — no table rebuild needed. Existing rows keep denormalized name strings
 * and get NULL ids; listing still best-effort redacts by matching those names to
 * currently-hidden NPC combatants. Fresh DBs never hit this path — BOOTSTRAP_SQL
 * already declares the columns.
 */
function migrateEncounterEventsTableForCombatantIds(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounter_events'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(encounter_events)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('actor_id')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN actor_id INTEGER');
  if (!has('target_id')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN target_id INTEGER');
}

/**
 * Issue #426: combat-log action provenance — chain_id, parent_event_id, phase,
 * performed_by_json, metadata_json. Plain nullable ADD COLUMNs; existing rows
 * remain valid flat events. Fresh DBs never hit this path (BOOTSTRAP_SQL).
 */
function migrateEncounterEventsTableForProvenance(sqlite: Database.Database): void {
  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounter_events'")
    .get();
  if (!hasTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(encounter_events)').all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('chain_id')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN chain_id TEXT');
  if (!has('parent_event_id')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN parent_event_id INTEGER');
  if (!has('phase')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN phase TEXT');
  if (!has('performed_by_json')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN performed_by_json TEXT');
  if (!has('metadata_json')) sqlite.exec('ALTER TABLE encounter_events ADD COLUMN metadata_json TEXT');
}

/**
 * Issue #466: `combatants.sheet_synced_updated_at` stores the character.updatedAt
 * CAS token from the last acknowledged sheet↔combatant HP sync. Plain nullable
 * ADD COLUMN — no table rebuild. Fresh DBs never hit this path (BOOTSTRAP_SQL).
 */
function migrateCombatantsTableForSheetSyncedUpdatedAt(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'sheet_synced_updated_at')) {
    sqlite.exec('ALTER TABLE combatants ADD COLUMN sheet_synced_updated_at TEXT');
  }
}

/**
 * Issue #413: `combatants.turn_state` (JSON CombatantTurnState — per-turn action-economy
 * usage, movement, concentration, delay/ready) and `combatants.active_effects` (JSON
 * ActiveEffect[] with duration + save timing) power the current-turn workspace. Plain
 * nullable ADD COLUMNs — no table rebuild. null degrades to the defaults (EMPTY_TURN_STATE
 * / []) in the read path. Fresh DBs never hit this path (BOOTSTRAP_SQL declares both).
 */
function migrateCombatantsTableForTurnState(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'turn_state')) {
    sqlite.exec('ALTER TABLE combatants ADD COLUMN turn_state TEXT');
  }
  if (!columns.some((c) => c.name === 'active_effects')) {
    sqlite.exec('ALTER TABLE combatants ADD COLUMN active_effects TEXT');
  }
}

/**
 * Issue #765: `combatants.initiative_group` stores the side label for OSR group-initiative
 * variants (e.g. "party", "monsters"). Combatants on the same side share one d6 roll.
 * Nullable plain ADD COLUMN — no table rebuild.
 */
function migrateCombatantsTableForInitiativeGroup(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'initiative_group')) {
    sqlite.exec('ALTER TABLE combatants ADD COLUMN initiative_group TEXT');
  }
}

function migrateCharactersTableForResources(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharactersTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'resources')) {
    sqlite.exec("ALTER TABLE characters ADD COLUMN resources TEXT NOT NULL DEFAULT '{}'");
  }
}

/**
 * Issue #423: `combatants.condition_instances` stores structured condition instances
 * (provenance, duration, save timing/DC, concentration, stacks, notes, custom).
 * Plain nullable ADD COLUMN — no table rebuild.
 */
function migrateCombatantsTableForConditionInstances(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'condition_instances')) {
    sqlite.exec('ALTER TABLE combatants ADD COLUMN condition_instances TEXT');
  }
}

/** Issue #425: inline homebrew statblock JSON on manual monster combatants. */
function migrateCombatantsTableForStatblockJson(sqlite: Database.Database): void {
  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (!hasCombatantsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'statblock_json')) {
    sqlite.exec('ALTER TABLE combatants ADD COLUMN statblock_json TEXT');
  }
}

/** Issue #425: campaign-scoped homebrew monster library for clone/edit/reuse. */
function migrateCampaignLibraryMonstersTable(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL creates the table with FKs.

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_library_monsters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      statblock_json TEXT NOT NULL,
      source_rule_entry_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_library_monsters_campaign ON campaign_library_monsters(campaign_id);
  `);
}

/** Issue #425: upgraded DBs created by migrateCampaignLibraryMonstersTable lack FK cascades. */
function migrateCampaignLibraryMonstersForeignKeys(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return; // fresh DB — BOOTSTRAP_SQL creates the table with FKs.

  const hasTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_library_monsters'")
    .get();
  if (!hasTable) return;

  const fks = sqlite.prepare('PRAGMA foreign_key_list(campaign_library_monsters)').all() as Array<{
    table: string;
    from: string;
  }>;
  const hasCampaignFk = fks.some((fk) => fk.from === 'campaign_id' && fk.table === 'campaigns');
  if (hasCampaignFk) return;

  sqlite.exec(`
    CREATE TABLE campaign_library_monsters_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      statblock_json TEXT NOT NULL,
      source_rule_entry_id INTEGER REFERENCES rule_entries(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO campaign_library_monsters_new
      (id, campaign_id, name, statblock_json, source_rule_entry_id, created_at, updated_at)
    SELECT clm.id, clm.campaign_id, clm.name, clm.statblock_json, clm.source_rule_entry_id, clm.created_at, clm.updated_at
    FROM campaign_library_monsters clm
    JOIN campaigns c ON c.id = clm.campaign_id;
    DROP TABLE campaign_library_monsters;
    ALTER TABLE campaign_library_monsters_new RENAME TO campaign_library_monsters;
    CREATE INDEX IF NOT EXISTS idx_campaign_library_monsters_campaign ON campaign_library_monsters(campaign_id);
  `);
}

/**
 * Issue #542: 13th Age initiative transparency and escalation die state.
 * Encounters store the current escalation value, hold/override controls, and a bounded
 * JSON history. Combatants store the initiative roll/modifier breakdown shown in the UI/log.
 */
function migrateArchmageEscalation542(sqlite: Database.Database): void {
  const hasEncountersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='encounters'")
    .get();
  if (hasEncountersTable) {
    const columns = sqlite.prepare('PRAGMA table_info(encounters)').all() as Array<{ name: string }>;
    const has = (name: string): boolean => columns.some((c) => c.name === name);
    if (!has('escalation_die')) sqlite.exec('ALTER TABLE encounters ADD COLUMN escalation_die INTEGER NOT NULL DEFAULT 0');
    if (!has('escalation_die_held')) sqlite.exec('ALTER TABLE encounters ADD COLUMN escalation_die_held INTEGER NOT NULL DEFAULT 0');
    if (!has('escalation_die_override')) sqlite.exec('ALTER TABLE encounters ADD COLUMN escalation_die_override INTEGER');
    if (!has('escalation_die_history')) sqlite.exec('ALTER TABLE encounters ADD COLUMN escalation_die_history TEXT');
  }

  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (hasCombatantsTable) {
    const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'initiative_breakdown')) {
      sqlite.exec('ALTER TABLE combatants ADD COLUMN initiative_breakdown TEXT');
    }
  }
}

/**
 * Issue #597: viewer capability + personal safety controls.
 *
 * `member_safety_controls` itself is created by BOOTSTRAP_SQL (which runs on every
 * boot and so reaches fresh AND upgraded DBs); this migration exists for the three
 * ALTER TABLE paths bootstrap cannot express, plus the one backfill that carries a
 * real product decision:
 *
 *   1. campaign_members.interactive_guest
 *   2. notifications.actor_user_id
 *   3. notification_digest_queue.actor_user_id
 *
 * THE MIGRATION POSTURE (grandfathering), stated once, here
 * --------------------------------------------------------
 * The default for the new column is 0 — every viewer seat becomes genuinely
 * read-only, which is what the role has always been documented to be. Applying that
 * to EXISTING seats unmodified would silently gag, mid-campaign, every viewer who
 * has been commenting at a live table. From the member's side that is
 * indistinguishable from a shadow-ban; from the DM's side it is an unexplained
 * outage in a table they never changed. So this migration GRANDFATHERS: a viewer
 * who has already demonstrably taken part — authored a comment, or a note that is
 * shared/whispered/inbox rather than private — is granted the interactive-guest
 * capability, because the DM has already, in practice, accepted them as a
 * participant.
 *
 * The grandfather is evidence-based and bounded, not a blanket exemption:
 *   - it only ever touches `role = 'viewer'` rows that have authored OUTBOUND content
 *     in that same campaign (a viewer with only private notes stays read-only —
 *     private notes were never gated in the first place);
 *   - every seat it touches gets a campaign-scoped audit row, so a DM auditing their
 *     table can see exactly which viewers retained the capability and why;
 *   - it is a one-time snapshot of the past. From this migration forward, every new
 *     viewer defaults to read-only and the capability is granted only by an explicit,
 *     audited DM action (PATCH /campaigns/:id/members/:memberId).
 *
 * The alternative — tightening immediately for everyone — is defensible on paper and
 * was rejected on one ground: it converts a safety improvement into an unannounced
 * removal of a capability people are actively using, which is how safety features
 * earn a reputation for breaking things and get turned off. A DM who WANTS the strict
 * outcome gets it with one toggle per seat, and can see which seats those are.
 */
function migrateSafetyControls597(sqlite: Database.Database): void {
  const tableExists = (table: string): boolean =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) != null;
  const hasColumn = (table: string, column: string): boolean =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);

  for (const table of ['notifications', 'notification_digest_queue'] as const) {
    if (!tableExists(table)) continue; // fresh DB — BOOTSTRAP_SQL already declares the column.
    if (!hasColumn(table, 'actor_user_id')) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN actor_user_id TEXT`);
    }
  }

  if (!tableExists('campaign_members')) return;
  const freshColumn = hasColumn('campaign_members', 'interactive_guest');
  if (!freshColumn) {
    sqlite.exec('ALTER TABLE campaign_members ADD COLUMN interactive_guest INTEGER NOT NULL DEFAULT 0');
  }

  // The grandfather runs whether or not this boot added the column: a DB created by an
  // earlier build of this branch already has the column (from BOOTSTRAP_SQL) but has
  // never had the backfill applied. Running it twice is harmless — the UPDATE is
  // idempotent and the audit insert is guarded on the same predicate.
  if (!tableExists('comments') || !tableExists('notes')) return;

  const grandfatherPredicate = `
    cm.role = 'viewer'
    AND cm.interactive_guest = 0
    AND (
      EXISTS (
        SELECT 1 FROM comments c
        WHERE c.campaign_id = cm.campaign_id AND c.author_user_id = CAST(cm.user_id AS TEXT)
      )
      OR EXISTS (
        SELECT 1 FROM notes n
        WHERE n.campaign_id = cm.campaign_id
          AND n.author_user_id = CAST(cm.user_id AS TEXT)
          AND (n.visibility <> 'private' OR n.kind = 'inbox')
      )
    )`;

  const seats = sqlite
    .prepare(`SELECT cm.id AS id, cm.campaign_id AS campaignId, cm.user_id AS userId FROM campaign_members cm WHERE ${grandfatherPredicate}`)
    .all() as Array<{ id: number; campaignId: number; userId: number }>;
  if (seats.length === 0) return;

  const nowTs = new Date().toISOString();
  const markGranted = sqlite.prepare('UPDATE campaign_members SET interactive_guest = 1 WHERE id = ?');
  const recordGrant = tableExists('audit_log')
    ? sqlite.prepare(
        `INSERT INTO audit_log (campaign_id, actor, actor_role, action, entity_type, entity_id, detail, created_at)
         VALUES (?, 'system:migration', 'admin', 'member.interactive_guest.grandfathered', 'campaign_member', ?, ?, ?)`,
      )
    : null;
  const apply = sqlite.transaction(() => {
    for (const seat of seats) {
      markGranted.run(seat.id);
      recordGrant?.run(
        seat.campaignId,
        seat.id,
        `issue #597: viewer ${seat.userId} kept interactive-guest because they had already posted in this campaign before the read-only tightening`,
        nowTs,
      );
    }
  });
  apply();
}

/**
 * Issue #601: moderation incidents — evidence snapshots, reports, mutes, and the
 * quarantine columns on the two moderated content tables.
 *
 * The three new tables (moderation_evidence / moderation_reports /
 * moderation_mutes) are created by BOOTSTRAP_SQL, which runs on every boot and so
 * reaches fresh AND upgraded DBs — same pattern entity_revisions (#157) uses. This
 * migration therefore exists only for the two ALTER TABLE paths bootstrap cannot
 * express: `comments.quarantined_at/_by` and `notes.quarantined_at/_by`. Both are
 * plain nullable ADD COLUMNs — no table rebuild, and no FTS trigger impact (the
 * comments FTS index covers `body`, which is untouched; quarantine is enforced as a
 * WHERE predicate alongside the existing deleted_at one, not by reindexing).
 *
 * Probes sqlite_master before PRAGMA table_info so a DB predating either table is a
 * clean no-op, matching migrateAiProviderConfigTable / migrateArchmageEscalation542.
 */
function migrateModerationIncidents601(sqlite: Database.Database): void {
  const columnNames = (table: string): string[] =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const tableExists = (table: string): boolean =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) != null;

  for (const table of ['comments', 'notes'] as const) {
    if (!tableExists(table)) continue; // fresh DB — BOOTSTRAP_SQL already declares both columns.
    const has = columnNames(table);
    if (!has.includes('quarantined_at')) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN quarantined_at TEXT`);
    if (!has.includes('quarantined_by')) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN quarantined_by TEXT`);
  }

  // `moderation_evidence.metadata_hash` was added after the table's first shape, so a
  // DB created by an earlier build of this branch has the table but not the column.
  // `CREATE TABLE IF NOT EXISTS` in BOOTSTRAP_SQL cannot add a column to an existing
  // table, so the ALTER belongs here. Defaults to '' — verifyModerationEvidence treats
  // an empty metadata digest as "nothing to verify against" rather than as tampering,
  // so pre-existing snapshots keep their old verdicts instead of being falsely accused.
  if (tableExists('moderation_evidence') && !columnNames('moderation_evidence').includes('metadata_hash')) {
    sqlite.exec("ALTER TABLE moderation_evidence ADD COLUMN metadata_hash TEXT NOT NULL DEFAULT ''");
  }
}

/**
 * Issue #604: durable responsive derivatives for image attachments.
 *
 * Pre-#604 servers have no `attachment_derivatives` table at all — the only
 * downscaled artifact was an opportunistic `<id>.thumb.png` written synchronously
 * on the first `?size=thumb` request, with no row backing it. This is therefore a
 * pure CREATE TABLE IF NOT EXISTS (plus its index): there is nothing to backfill in
 * SQL, and deliberately so. Existing attachments are planned lazily by
 * AttachmentDerivativesService's boot backfill, which must read each original's
 * header (to skip rungs no smaller than the source) — work that belongs in the
 * bounded background drain, not in a migration that blocks server start.
 *
 * A legacy `<id>.thumb.png` left on disk by the old code is not adopted: with no row
 * it is simply regenerated by the `thumb` rung and overwritten, which also upgrades
 * it from the old PNG-subset decoder's output to a sharp render.
 */
function migrateAttachmentDerivativesTable604(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS attachment_derivatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL,
      variant TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      format TEXT NOT NULL DEFAULT '',
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL DEFAULT '',
      source_etag TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (attachment_id, variant)
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_derivatives_state ON attachment_derivatives(state);
  `);
}

/**
 * Issue #413: campaign turn-advancement controls. `dm_controls_turns` keeps combat
 * advancement DM-only (a player cannot end their own turn); `require_dm_turn_confirmation`
 * stages a player's end-turn for DM approval instead of advancing immediately. Both plain
 * NOT NULL DEFAULT 0 ADD COLUMNs — no table rebuild. Fresh DBs never hit this path
 * (BOOTSTRAP_SQL declares both).
 */
function migrateCampaignsTableForTurnControls(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'dm_controls_turns')) {
    sqlite.exec('ALTER TABLE campaigns ADD COLUMN dm_controls_turns INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some((c) => c.name === 'require_dm_turn_confirmation')) {
    sqlite.exec('ALTER TABLE campaigns ADD COLUMN require_dm_turn_confirmation INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Issue #635: campaign AI narration language. Plain NOT NULL DEFAULT 'en' ADD COLUMN —
 * existing campaigns keep English narration. Fresh DBs never hit this path (BOOTSTRAP_SQL
 * already declares narration_language).
 */
function migrateCampaignsTableForNarrationLanguage(sqlite: Database.Database): void {
  const hasCampaignsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (!hasCampaignsTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'narration_language')) {
    sqlite.exec("ALTER TABLE campaigns ADD COLUMN narration_language TEXT NOT NULL DEFAULT 'en'");
  }
}

/**
 * Issue #877: create the participant-owned access-support table. This is a new
 * table rather than columns on the shared session_zero row so ownership,
 * per-participant deletion, human visibility, and AI consent remain independent.
 * Existing installs start with no submissions; no private content is inferred or
 * copied during upgrade. The conservative defaults are facilitator-only and no AI.
 */
function migrateParticipantSupportPreferences(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS participant_support_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL,
      owner_name TEXT NOT NULL DEFAULT '',
      support_text TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'facilitator' CHECK (visibility IN ('table', 'facilitator')),
      ai_use_consent INTEGER NOT NULL DEFAULT 0 CHECK (ai_use_consent IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, owner_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_participant_support_campaign
      ON participant_support_preferences(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_participant_support_ai_consent
      ON participant_support_preferences(campaign_id, ai_use_consent);
  `);

}

/**
 * Migration for DBs created before persistent death/temp-HP on character sheets
 * (issue #711): `characters.hp_temp`, `death_state`, and death-save counters didn't
 * exist. Plain ADD COLUMN with NOT NULL DEFAULT — no table rebuild needed, same shape
 * as migrateCharactersTableForStatus above. Existing rows read as alive (none)
 * with zero temp HP and zero death-save counters, which is correct for every
 * pre-#711 sheet (the death subsystem existed only on combatants before). Fresh
 * DBs never hit this path — BOOTSTRAP_SQL already declares the columns.
 */
function migrateCharactersTableForDeathTempHp(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharactersTable) return; // fresh DB — BOOTSTRAP_SQL below creates it correctly.

  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  const has = (name: string): boolean => columns.some((c) => c.name === name);
  // Add each column individually — ALTER TABLE ADD COLUMN takes one column at a
  // time. NOT NULL with a literal DEFAULT back-fills every existing row, so the
  // post-#711 read path observes a clean alive/temp-less state on legacy sheets.
  if (!has('hp_temp')) sqlite.exec("ALTER TABLE characters ADD COLUMN hp_temp INTEGER NOT NULL DEFAULT 0");
  if (!has('death_state')) sqlite.exec("ALTER TABLE characters ADD COLUMN death_state TEXT NOT NULL DEFAULT 'none'");
  if (!has('death_save_successes'))
    sqlite.exec('ALTER TABLE characters ADD COLUMN death_save_successes INTEGER NOT NULL DEFAULT 0');
  if (!has('death_save_failures'))
    sqlite.exec('ALTER TABLE characters ADD COLUMN death_save_failures INTEGER NOT NULL DEFAULT 0');
}

/**
 * Migration for DBs created before notification deep-links could focus a specific
 * comment (issue #446): `notifications.comment_id` didn't exist. Plain nullable
 * ADD COLUMN — no table rebuild. Existing rows stay null (parent-entity link only).
 * Fresh DBs never hit this path — BOOTSTRAP_SQL already declares the column.
 */
function migrateNotificationsTableForCommentId(sqlite: Database.Database): void {
  const hasNotificationsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'")
    .get();
  if (!hasNotificationsTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'comment_id')) return;

  sqlite.exec('ALTER TABLE notifications ADD COLUMN comment_id INTEGER');
}

/**
 * Migration for issue #820: schedule lifecycle notifications store structured
 * metadata (schedule id, UTC instant, duration, change type) in
 * `notifications.data` so clients can localize the start time. Plain nullable
 * ADD COLUMN — existing rows stay null. Fresh DBs never hit this path —
 * BOOTSTRAP_SQL already declares the column.
 */
function migrateNotificationsTableForData(sqlite: Database.Database): void {
  const hasNotificationsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'")
    .get();
  if (!hasNotificationsTable) return;

  const columns = sqlite.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'data')) return;

  sqlite.exec('ALTER TABLE notifications ADD COLUMN data TEXT');
}

/**
 * Migration for issue #819: character assignment is an exclusive seat — at most
 * one campaign_members row may reference a given character_id. Pre-fix DBs could
 * accumulate duplicate links (the service overwrote ownerUserId without clearing
 * the previous seat). This migration:
 *
 *   1. Collapses duplicates so the unique index can be created. For each
 *      character_id with multiple seats, keep the member whose user_id matches
 *      characters.owner_user_id (canonical owner); fall back to the earliest
 *      membership id. Losing seats are unlinked (character_id cleared), never
 *      deleted — the member stays in the campaign.
 *   2. Creates the partial unique index idempotently (BOOTSTRAP_SQL declares the
 *      same name for fresh DBs).
 */
function migrateCampaignMembersExclusiveCharacter(sqlite: Database.Database): void {
  const hasMembersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_members'")
    .get();
  if (!hasMembersTable) return;

  // Prefer the seat whose user matches the character's owner_user_id (string form
  // of users.id). When no seat matches the owner (or the character is missing),
  // keep MIN(id) so the index can be applied deterministically.
  const dupGroups = sqlite
    .prepare(
      `SELECT character_id
       FROM campaign_members
       WHERE character_id IS NOT NULL
       GROUP BY character_id
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ character_id: number }>;

  const seatsFor = sqlite.prepare(
    `SELECT id, user_id FROM campaign_members WHERE character_id = ? ORDER BY id ASC`,
  );
  const ownerOf = sqlite.prepare(`SELECT owner_user_id FROM characters WHERE id = ? LIMIT 1`);
  const unlink = sqlite.prepare(
    `UPDATE campaign_members SET character_id = NULL, updated_at = datetime('now') WHERE id = ?`,
  );

  for (const { character_id } of dupGroups) {
    const seats = seatsFor.all(character_id) as Array<{ id: number; user_id: number }>;
    const ownerRow = ownerOf.get(character_id) as { owner_user_id: string | null } | undefined;
    const ownerUserId = ownerRow?.owner_user_id ?? null;
    const keep =
      (ownerUserId != null ? seats.find((s) => String(s.user_id) === ownerUserId) : undefined) ?? seats[0];
    if (!keep) continue;
    for (const seat of seats) {
      if (seat.id !== keep.id) unlink.run(seat.id);
    }
  }

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_members_character
      ON campaign_members(character_id) WHERE character_id IS NOT NULL;
  `);
}

/**
 * Issue #782: per-action idempotency for inventory quantity writes. CREATE TABLE
 * IF NOT EXISTS is fully idempotent; fresh DBs never hit this path because
 * BOOTSTRAP_SQL already declares the table. Same shape as other new-table
 * migrations (e.g. 0051 server_meta).
 */
function migrateInventoryQtyIdempotencyTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inventory_qty_idempotency (
      key TEXT PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_inventory_qty_idempotency_item
      ON inventory_qty_idempotency(item_id);
  `);
}

/** Issue #782: created_at index so TTL prune-on-write is a range scan, not a table scan. */
function migrateInventoryQtyIdempotencyCreatedAtIndex(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_inventory_qty_idempotency_created
      ON inventory_qty_idempotency(created_at);
  `);
}

/**
 * Issue #867: server-level purge tombstones. NEW table (no ALTER) — CREATE TABLE
 * IF NOT EXISTS is fully idempotent. No FKs by design: rows must outlive the
 * campaign hard-cascade they document.
 */
function migrateCampaignPurgeTombstones(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_purge_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      campaign_name_hash TEXT NOT NULL,
      actor TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      requested_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
}

/**
 * Ordered, named registry of the hand-rolled migrations above (issue #69). Each
 * entry is applied at most once and its name is recorded in the `__migrations`
 * schema-version table, replacing the previous "call every migrate* fn on every
 * boot and trust it to self-probe" arrangement. The functions themselves remain
 * individually idempotent (they still PRAGMA table_info before touching anything),
 * so an old DB that predates the `__migrations` table — where the applied-set is
 * empty and every migration re-runs — is brought fully up to shape without harm.
 *
 * The ORDER is load-bearing and must never be reordered or have entries removed:
 * it is the canonical sequence in which an old-shaped DB is upgraded (mirrors the
 * historical call order in openDatabase). Append new migrations to the END only.
 */
function migratePartyRestBatches759(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS party_rest_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL, preview_token TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'previewed',
      idempotency_key TEXT, before_json TEXT NOT NULL DEFAULT '{}', plan_json TEXT NOT NULL DEFAULT '{}',
      after_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      applied_at TEXT, undone_at TEXT, UNIQUE(campaign_id, actor_user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_party_rest_batches_campaign ON party_rest_batches(campaign_id, created_at DESC);
  `);
  const columns = sqlite.pragma('table_info(party_rest_batches)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'undo_idempotency_key')) sqlite.exec('ALTER TABLE party_rest_batches ADD COLUMN undo_idempotency_key TEXT');
  if (!columns.some((column) => column.name === 'undo_result_json')) sqlite.exec("ALTER TABLE party_rest_batches ADD COLUMN undo_result_json TEXT NOT NULL DEFAULT '{}'");
}

function _migrateImportJobsTable(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS import_jobs (id TEXT PRIMARY KEY, source TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', input TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', progress TEXT NOT NULL DEFAULT '{}', cursor TEXT, actor_id TEXT NOT NULL DEFAULT '', started_at TEXT, updated_at TEXT NOT NULL, completed_at TEXT, outcome TEXT, errors TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status); CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at ON import_jobs(created_at);`);
}

function migrateStarfinderCombatState(sqlite: Database.Database): void {
  const hasCharactersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (hasCharactersTable) {
    const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
    const has = (name: string): boolean => columns.some((c) => c.name === name);
    if (!has('sp_current')) sqlite.exec('ALTER TABLE characters ADD COLUMN sp_current INTEGER NOT NULL DEFAULT 0');
    if (!has('sp_max')) sqlite.exec('ALTER TABLE characters ADD COLUMN sp_max INTEGER NOT NULL DEFAULT 0');
    if (!has('rp_current')) sqlite.exec('ALTER TABLE characters ADD COLUMN rp_current INTEGER NOT NULL DEFAULT 0');
    if (!has('rp_max')) sqlite.exec('ALTER TABLE characters ADD COLUMN rp_max INTEGER NOT NULL DEFAULT 0');
    if (!has('eac')) sqlite.exec('ALTER TABLE characters ADD COLUMN eac INTEGER');
    if (!has('kac')) sqlite.exec('ALTER TABLE characters ADD COLUMN kac INTEGER');
  }

  const hasCombatantsTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='combatants'")
    .get();
  if (hasCombatantsTable) {
    const columns = sqlite.prepare('PRAGMA table_info(combatants)').all() as Array<{ name: string }>;
    const has = (name: string): boolean => columns.some((c) => c.name === name);
    if (!has('sp_current')) sqlite.exec('ALTER TABLE combatants ADD COLUMN sp_current INTEGER NOT NULL DEFAULT 0');
    if (!has('sp_max')) sqlite.exec('ALTER TABLE combatants ADD COLUMN sp_max INTEGER NOT NULL DEFAULT 0');
    if (!has('rp_current')) sqlite.exec('ALTER TABLE combatants ADD COLUMN rp_current INTEGER NOT NULL DEFAULT 0');
    if (!has('rp_max')) sqlite.exec('ALTER TABLE combatants ADD COLUMN rp_max INTEGER NOT NULL DEFAULT 0');
    if (!has('eac')) sqlite.exec('ALTER TABLE combatants ADD COLUMN eac INTEGER');
    if (!has('kac')) sqlite.exec('ALTER TABLE combatants ADD COLUMN kac INTEGER');
  }
}

/**
 * Issue #617: composite indexes aligned to the hot campaign-scoped history reads
 * (notes newest-first, comment threads, schedule calendar order, timeline sort,
 * dice-roll feed + retention prune). Replaces single-column campaign_id indexes
 * where ORDER BY can now be served from the index rather than a filesort.
 *
 * Runs before BOOTSTRAP_SQL — on a fresh DB the tables do not exist yet, so each
 * block is a no-op and bootstrap creates the composites on first boot instead.
 */
function migrateHotHistoryCompositeIndexes(sqlite: Database.Database): void {
  const hasTable = (name: string) =>
    !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  if (hasTable('notes')) {
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_notes_campaign;
      CREATE INDEX IF NOT EXISTS idx_notes_campaign_id_desc
        ON notes(campaign_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_notes_inbox_resolved
        ON notes(campaign_id, kind, resolved, updated_at DESC, id DESC);
    `);
  }

  if (hasTable('comments')) {
    sqlite.exec(`
      -- idx_comments_entity existed as (campaign_id, entity_type, entity_id); add id so
      -- ORDER BY id ASC can be served from the index without a filesort.
      DROP INDEX IF EXISTS idx_comments_entity;
      CREATE INDEX IF NOT EXISTS idx_comments_entity
        ON comments(campaign_id, entity_type, entity_id, id);
      CREATE INDEX IF NOT EXISTS idx_comments_campaign_id
        ON comments(campaign_id, id);
    `);
  }

  if (hasTable('scheduled_sessions')) {
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_scheduled_sessions_campaign;
      CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_campaign_at
        ON scheduled_sessions(campaign_id, scheduled_at, id);
    `);
  }

  if (hasTable('timeline_events')) {
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_timeline_events_campaign;
      CREATE INDEX IF NOT EXISTS idx_timeline_events_campaign_sort
        ON timeline_events(campaign_id, sort_index, id);
    `);
  }

  if (hasTable('dice_rolls')) {
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_dice_rolls_campaign;
      CREATE INDEX IF NOT EXISTS idx_dice_rolls_campaign_id_desc
        ON dice_rolls(campaign_id, id DESC);
    `);
  }
}

function migrateAuditLogForRequestId(sqlite: Database.Database): void {
  const hasTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
  if (!hasTable) return;
  const columns = sqlite.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'request_id')) {
    sqlite.exec('ALTER TABLE audit_log ADD COLUMN request_id TEXT');
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id)');
}

/**
 * Issue #549 — per-user, per-campaign catch-up cursor for the dashboard
 * "since you were last here" panel. Fresh DBs get the table from BOOTSTRAP_SQL;
 * upgraded installs create it here.
 */
function migrateCampaignCatchUpCursorsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_catch_up_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      last_caught_up_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, campaign_id)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_catch_up_campaign
      ON campaign_catch_up_cursors(campaign_id);
  `);
}

/**
 * Issue #1644 — inbox sweep auditable job record + per-item idempotency ledger.
 * Fresh DBs get both tables from BOOTSTRAP_SQL; upgraded installs create them here.
 */
function migrateInboxSweepTables1644(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbox_sweep_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      items_total INTEGER NOT NULL DEFAULT 0,
      items_proposed INTEGER NOT NULL DEFAULT 0,
      items_skipped INTEGER NOT NULL DEFAULT 0,
      items_errored INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_sweep_jobs_campaign ON inbox_sweep_jobs(campaign_id, created_at);

    CREATE TABLE IF NOT EXISTS inbox_sweep_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES inbox_sweep_jobs(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      proposal_id INTEGER,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, note_id)
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_sweep_items_job ON inbox_sweep_items(job_id);
  `);
}

function migrateAiScribeSessionScope499(sqlite: Database.Database): void {
  const hasConfigs = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_scribe_configs'")
    .get();
  if (hasConfigs) {
    const configCols = sqlite.prepare('PRAGMA table_info(ai_scribe_configs)').all() as Array<{ name: string }>;
    if (!configCols.some((c) => c.name === 'source_cursor_at')) {
      sqlite.exec('ALTER TABLE ai_scribe_configs ADD COLUMN source_cursor_at TEXT');
    }
  }

  const hasJobs = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_scribe_jobs'")
    .get();
  if (hasJobs) {
    const jobCols = sqlite.prepare('PRAGMA table_info(ai_scribe_jobs)').all() as Array<{ name: string }>;
    if (!jobCols.some((c) => c.name === 'scheduled_session_id')) {
      sqlite.exec('ALTER TABLE ai_scribe_jobs ADD COLUMN scheduled_session_id INTEGER');
    }
    if (!jobCols.some((c) => c.name === 'source_stats')) {
      sqlite.exec('ALTER TABLE ai_scribe_jobs ADD COLUMN source_stats TEXT');
    }
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_ai_scribe_jobs_session_trigger
      ON ai_scribe_jobs(campaign_id, scheduled_session_id, trigger);
  `);
}

/**
 * Issue #545: protected campaign owner plus temporary guest/co-DM grants.
 *
 * Existing campaigns did not record their owner separately from the mutable DM
 * role. On upgrade, mark the earliest DM seat in each campaign as primary owner
 * so ordinary co-DM role edits/removals can no longer orphan the original
 * authority path. The guest grant table is new and idempotent.
 */
function migrateGuestDmHandoff545(sqlite: Database.Database): void {
  const hasMembersTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_members'")
    .get();
  if (hasMembersTable) {
    const columns = sqlite.prepare('PRAGMA table_info(campaign_members)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'is_primary_owner')) {
      sqlite.exec('ALTER TABLE campaign_members ADD COLUMN is_primary_owner INTEGER NOT NULL DEFAULT 0');
      sqlite.exec(`
        UPDATE campaign_members
        SET is_primary_owner = 1
        WHERE id IN (
          SELECT MIN(id)
          FROM campaign_members
          WHERE role = 'dm'
          GROUP BY campaign_id
        )
      `);
    }
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_guest_dm_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      grantee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      scopes TEXT NOT NULL DEFAULT '["dm"]',
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      handed_back_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_guest_dm_grants_active
      ON campaign_guest_dm_grants(campaign_id, grantee_user_id, starts_at, expires_at);
  `);
}

/**
 * Issue #504: scheduled sessions are no longer deleted when cancelled. Add a
 * lifecycle status, cancellation metadata, and nullable schedule↔play-log links.
 */
function migrateSchedulingLifecycle504(sqlite: Database.Database): void {
  const hasScheduledSessions = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_sessions'")
    .get();
  if (hasScheduledSessions) {
    const scheduleCols = sqlite.prepare('PRAGMA table_info(scheduled_sessions)').all() as Array<{ name: string }>;
    const has = (name: string) => scheduleCols.some((c) => c.name === name);
    if (!has('status')) sqlite.exec("ALTER TABLE scheduled_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled'");
    if (!has('cancelled_at')) sqlite.exec('ALTER TABLE scheduled_sessions ADD COLUMN cancelled_at TEXT');
    if (!has('cancelled_by')) sqlite.exec('ALTER TABLE scheduled_sessions ADD COLUMN cancelled_by TEXT');
    if (!has('cancellation_reason')) sqlite.exec("ALTER TABLE scheduled_sessions ADD COLUMN cancellation_reason TEXT NOT NULL DEFAULT ''");
    if (!has('session_id')) sqlite.exec('ALTER TABLE scheduled_sessions ADD COLUMN session_id INTEGER');
  }

  const hasSessions = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  if (hasSessions) {
    const sessionCols = sqlite.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionCols.some((c) => c.name === 'scheduled_session_id')) {
      sqlite.exec('ALTER TABLE sessions ADD COLUMN scheduled_session_id INTEGER');
    }
  }
}

/**
 * Issue #547 — expiring, read-only Player Display cast sessions. These are
 * capability tokens for shared TVs/kiosks, stored hashed like recap shares.
 */
function migrateCastSessionsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cast_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      exit_pin_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      first_accessed_at TEXT,
      last_accessed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cast_sessions_campaign ON cast_sessions(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_cast_sessions_expires_at ON cast_sessions(expires_at);
  `);
}

/**
 * Issue #572: the authoritative multi-player AI-DM table transcript.
 *
 * New table only — no existing table is touched, so the migration is CREATE ... IF NOT
 * EXISTS plus a defensive column probe. The probe matters because an early build of this
 * branch shipped the table WITHOUT the per-campaign `seq` / `turn_id` columns (it used
 * the global row id as the cursor); a dev database created from that build must gain the
 * columns and a backfilled per-campaign `seq` rather than silently failing every insert.
 * `seq` is backfilled in (campaign_id, id) order — exactly the order the rows were written.
 *
 * The ALTER branch is BRANCH-LOCAL DEV SALVAGE, not a production upgrade path: the table
 * is new in this change, so no released database can have the old shape. One cosmetic
 * consequence is worth knowing about — a fresh database gets `seq INTEGER NOT NULL` from
 * the CREATE above, while a salvaged dev database gets a NULLABLE `seq`, because SQLite
 * cannot ADD a NOT NULL column without a default. It is harmless (the service always
 * supplies `seq`, and UNIQUE (campaign_id, seq) is what actually guards the sequence), and
 * rewriting the table to tighten the constraint would cost a 12-column copy/drop/rename
 * for dev databases only. Noted rather than fixed, deliberately.
 */
function migrateAiDmTranscriptEventsTable572(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_dm_transcript_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor_user_id TEXT,
      actor_name TEXT,
      client_ref TEXT,
      turn_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      visibility TEXT NOT NULL DEFAULT 'all',
      created_at TEXT NOT NULL
    );
  `);

  const columns = sqlite.prepare('PRAGMA table_info(ai_dm_transcript_events)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'turn_id')) {
    sqlite.exec('ALTER TABLE ai_dm_transcript_events ADD COLUMN turn_id TEXT');
  }
  if (!columns.some((c) => c.name === 'seq')) {
    // SQLite cannot ADD a NOT NULL column without a default: add it nullable, backfill a
    // dense per-campaign sequence in write order, then let the UNIQUE index enforce it.
    sqlite.exec('ALTER TABLE ai_dm_transcript_events ADD COLUMN seq INTEGER');
    sqlite.exec(`
      UPDATE ai_dm_transcript_events
      SET seq = (
        SELECT COUNT(*)
        FROM ai_dm_transcript_events AS earlier
        WHERE earlier.campaign_id = ai_dm_transcript_events.campaign_id
          AND earlier.id <= ai_dm_transcript_events.id
      )
      WHERE seq IS NULL
    `);
  }

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_dm_transcript_events_campaign_seq
      ON ai_dm_transcript_events (campaign_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_dm_transcript_events_event_id
      ON ai_dm_transcript_events (campaign_id, event_id);
  `);
}

/**
 * Issue #580 — per-intent idempotency records for non-idempotent encounter mutations
 * (HP deltas, turn advancement). Purely additive: a new table plus its indexes, so the
 * whole migration is `CREATE ... IF NOT EXISTS` and is safe to re-run. The `PRAGMA
 * table_info` probe below is belt-and-braces for the one case IF NOT EXISTS cannot
 * cover — an install that somehow carries an EARLIER shape of the table (there is none
 * shipped, but the ordinal after this one must not have to guess) — and re-creates it.
 * Dropping is safe: the table holds only short-lived replay records, never durable
 * campaign state, so the worst case of losing it is that an in-flight retry re-applies.
 */
function migrateEncounterOpIdempotency580(sqlite: Database.Database): void {
  const existing = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='encounter_op_idempotency'`).all();
  if (existing.length > 0) {
    const cols = sqlite.prepare(`PRAGMA table_info(encounter_op_idempotency)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const expected = ['actor_id', 'operation', 'key', 'encounter_id', 'campaign_id', 'fingerprint', 'response_json', 'response_role', 'created_at'];
    if (expected.every((c) => names.has(c))) return;
    sqlite.exec(`DROP TABLE encounter_op_idempotency`);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS encounter_op_idempotency (
      actor_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      key TEXT NOT NULL,
      encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT,
      response_role TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (actor_id, operation, key)
    );
    CREATE INDEX IF NOT EXISTS idx_encounter_op_idempotency_created ON encounter_op_idempotency(created_at);
    CREATE INDEX IF NOT EXISTS idx_encounter_op_idempotency_encounter ON encounter_op_idempotency(encounter_id);
  `);
}

/**
 * Issue #577 — grounding verdicts on the AI driver's factual claims (rules rulings and
 * assertions about existing canon), with the provider/model provenance and the human
 * correction that supersedes an unsupported one.
 *
 * Purely additive: one new table plus its index, so the whole body is `CREATE ... IF NOT
 * EXISTS` and re-running it is a no-op. The `sqlite_master` / `PRAGMA table_info` probe is the
 * belt for the case IF NOT EXISTS cannot cover — an install carrying an EARLIER shape of the
 * table. Dropping in that case is acceptable and deliberate: the rows are an audit-style review
 * trail for past turns, not durable campaign canon, and the alternative (guessing which columns
 * to ALTER in) is how a half-migrated table gets shipped.
 */
function migrateAiDriverGroundingClaims577(sqlite: Database.Database): void {
  const existing = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_driver_grounding_claims'`)
    .all();
  if (existing.length > 0) {
    const cols = sqlite.prepare(`PRAGMA table_info(ai_driver_grounding_claims)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const expected = [
      'id',
      'campaign_id',
      'turn',
      'claim_index',
      'kind',
      'claim_text',
      'status',
      'reason',
      'citations_json',
      'provider',
      'model',
      'created_at',
      'correction',
      'corrected_by',
      'corrected_at',
    ];
    if (expected.every((c) => names.has(c))) return;
    sqlite.exec(`DROP TABLE ai_driver_grounding_claims`);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_driver_grounding_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      turn INTEGER NOT NULL,
      claim_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      correction TEXT,
      corrected_by TEXT,
      corrected_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_driver_grounding_campaign
      ON ai_driver_grounding_claims(campaign_id, id);
  `);
}

/**
 * Issue #588 — organized-play scheduling: venue/room resources, recurring series,
 * a per-occurrence exception ledger, reusable schedule templates, and the
 * organized-play decoration on `scheduled_sessions` (series link, explicit IANA
 * timezone + local wall clock, room/DM assignment, capacity, event/season keys,
 * stable ICS UID/SEQUENCE, and reschedule lineage).
 *
 * Purely additive: new tables are `CREATE TABLE IF NOT EXISTS`, and every column
 * added to `scheduled_sessions` is guarded by a `PRAGMA table_info` probe, so the
 * whole migration is safe to re-run (boot is not once-only — DbHolder re-runs it
 * after a restore).
 *
 * The FK on `scheduled_sessions.series_id` cannot be added by ALTER (SQLite has no
 * ADD CONSTRAINT), so on an upgraded DB the column is a plain INTEGER while a
 * freshly bootstrapped DB carries the declared REFERENCES. That asymmetry already
 * exists throughout this file (see migrateSchedulingLifecycle504's `session_id`)
 * and is why series teardown is written as an explicit delete in
 * CampaignsService.purge() rather than left to the constraint.
 */
function migrateOrganizedPlay588(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS play_venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      address TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS play_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL REFERENCES play_venues(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(venue_id, name)
    );
    CREATE TABLE IF NOT EXISTS session_series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      start_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 240,
      freq TEXT NOT NULL DEFAULT 'weekly',
      interval INTEGER NOT NULL DEFAULT 1,
      count INTEGER NOT NULL DEFAULT 1,
      until_date TEXT,
      venue_id INTEGER REFERENCES play_venues(id) ON DELETE SET NULL,
      room_id INTEGER REFERENCES play_rooms(id) ON DELETE SET NULL,
      assigned_dm_user_id TEXT NOT NULL DEFAULT '',
      capacity INTEGER NOT NULL DEFAULT 0,
      event_id TEXT NOT NULL DEFAULT '',
      season_id TEXT NOT NULL DEFAULT '',
      series_uid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS series_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL REFERENCES session_series(id) ON DELETE CASCADE,
      occurrence_id INTEGER REFERENCES scheduled_sessions(id) ON DELETE SET NULL,
      recurrence_local_date TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      from_scheduled_at TEXT,
      to_scheduled_at TEXT,
      to_local_start TEXT NOT NULL DEFAULT '',
      -- #588: what the entry actually CHANGED. Without these the ledger records
      -- only the instants, so an A->B->C sequence of room moves leaves B
      -- unrecoverable — the surviving occurrence holds only C — and the
      -- "append-only exception lineage" could not answer the one question a
      -- coordinator asks it. from_* == to_* on a cancel/restore, which records the
      -- seating in force at that moment rather than pretending nothing was held.
      from_room_id INTEGER,
      to_room_id INTEGER,
      from_assigned_dm_user_id TEXT NOT NULL DEFAULT '',
      to_assigned_dm_user_id TEXT NOT NULL DEFAULT '',
      from_capacity INTEGER NOT NULL DEFAULT 0,
      to_capacity INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      actor_user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      venue_id INTEGER REFERENCES play_venues(id) ON DELETE SET NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      freq TEXT NOT NULL DEFAULT 'weekly',
      interval INTEGER NOT NULL DEFAULT 1,
      count INTEGER NOT NULL DEFAULT 8,
      event_id TEXT NOT NULL DEFAULT '',
      season_id TEXT NOT NULL DEFAULT '',
      slots_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_play_rooms_venue ON play_rooms(venue_id);
    CREATE INDEX IF NOT EXISTS idx_session_series_campaign ON session_series(campaign_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_series_uid ON session_series(series_uid);
    CREATE INDEX IF NOT EXISTS idx_series_exceptions_series ON series_exceptions(series_id, id);
    CREATE INDEX IF NOT EXISTS idx_series_exceptions_occurrence ON series_exceptions(occurrence_id);
  `);

  const hasScheduledSessions = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_sessions'")
    .get();
  if (!hasScheduledSessions) return;

  const cols = sqlite.prepare('PRAGMA table_info(scheduled_sessions)').all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some((c) => c.name === name);
  const addColumns: Array<[string, string]> = [
    ['series_id', 'INTEGER'],
    ['occurrence_index', 'INTEGER NOT NULL DEFAULT 0'],
    ['timezone', "TEXT NOT NULL DEFAULT ''"],
    ['local_start', "TEXT NOT NULL DEFAULT ''"],
    ['venue_id', 'INTEGER'],
    ['room_id', 'INTEGER'],
    ['assigned_dm_user_id', "TEXT NOT NULL DEFAULT ''"],
    ['capacity', 'INTEGER NOT NULL DEFAULT 0'],
    ['event_id', "TEXT NOT NULL DEFAULT ''"],
    ['season_id', "TEXT NOT NULL DEFAULT ''"],
    ['ics_uid', "TEXT NOT NULL DEFAULT ''"],
    ['ics_sequence', 'INTEGER NOT NULL DEFAULT 0'],
    ['original_scheduled_at', 'TEXT'],
  ];
  for (const [name, ddl] of addColumns) {
    if (!has(name)) sqlite.exec(`ALTER TABLE scheduled_sessions ADD COLUMN ${name} ${ddl}`);
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_at ON scheduled_sessions(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_room_at ON scheduled_sessions(room_id, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_dm_at ON scheduled_sessions(assigned_dm_user_id, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_series ON scheduled_sessions(series_id, occurrence_index);
  `);
}

/**
 * Issue #588 — backfill the stable ICS UID for every pre-existing scheduled
 * session. Deliberately a SEPARATE, ADJACENT ordinal after the create/ALTER step
 * above (0123): the create must be recorded as applied even if a backfill on a
 * huge table is interrupted, and splitting them keeps that recovery honest.
 *
 * The backfilled string is EXACTLY the UID `buildCampaignIcs` has always emitted
 * (`campfire-c<campaign>-s<id>@campfire`). Minting a fresh UID here would tell
 * every already-subscribed calendar that each existing event was deleted and a
 * different one created — the ghost-accumulation this feature is meant to stop.
 * Only rows with an empty ics_uid are touched, so re-running is a no-op.
 */
function migrateOrganizedPlayIcsUidBackfill588(sqlite: Database.Database): void {
  const hasScheduledSessions = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_sessions'")
    .get();
  if (!hasScheduledSessions) return;
  const cols = sqlite.prepare('PRAGMA table_info(scheduled_sessions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'ics_uid')) return;
  sqlite.exec(`
    UPDATE scheduled_sessions
       SET ics_uid = 'campfire-c' || campaign_id || '-s' || id || '@campfire'
     WHERE ics_uid = ''
  `);
}

/**
 * Issue #585 — campaign module package identity, install/fork lineage, per-artifact
 * baselines and pre-apply snapshots.
 *
 * Executes the SAME `CAMPAIGN_MODULES_DDL` text that BOOTSTRAP_SQL interpolates, so a
 * fresh DB and an upgraded DB get an identical shape by construction rather than by two
 * hand-kept copies. Every statement is `IF NOT EXISTS`, which makes this idempotent on
 * its own and safe in either order relative to bootstrap (migrations run first).
 *
 * No sqlite_master probe is needed to decide whether to run — but we DO probe before the
 * back-compat guard below, because an early build of this branch could have created the
 * installs table without the fork-lineage columns.
 */
function migrateCampaignModules585(sqlite: Database.Database): void {
  sqlite.exec(CAMPAIGN_MODULES_DDL);
  const hasInstalls = !!sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_module_installs'")
    .get();
  if (!hasInstalls) return;
  const columns = new Set(
    (sqlite.pragma('table_info(campaign_module_installs)') as Array<{ name: string }>).map((c) => c.name),
  );
  const addColumn = (name: string, ddl: string) => {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE campaign_module_installs ADD COLUMN ${ddl}`);
  };
  addColumn('origin_kind', "origin_kind TEXT NOT NULL DEFAULT 'install'");
  addColumn('origin_source_url', "origin_source_url TEXT NOT NULL DEFAULT ''");
  addColumn('upstream_module_id', 'upstream_module_id TEXT');
  addColumn('upstream_version', 'upstream_version TEXT');
  addColumn('forked_at', 'forked_at TEXT');
  addColumn('detached', 'detached INTEGER NOT NULL DEFAULT 0');
  addColumn('detached_at', 'detached_at TEXT');
}

/**
 * Issue #600: session-zero consent lifecycle.
 *
 * Five pieces, all probe-before-act and all idempotent:
 *
 *  1. `session_zero.preview_policy` — ADD COLUMN with a constant NOT NULL default, so
 *     existing charters backfill to the conservative 'boundaries' value in one statement.
 *     No table rebuild.
 *  2-5. Four brand-new tables. House style (see migrateAiDriverGroundingClaims577):
 *     probe sqlite_master, verify the expected column set, DROP/recreate only when an
 *     earlier partial shape is found, and leave a correct pre-existing table untouched.
 *
 * The tables are created in FK dependency order — versions before acknowledgments and
 * guardian consents, which reference it — because SQLite validates a REFERENCES clause
 * against the parent table at CREATE time when foreign_keys is on.
 *
 * Fresh DBs never take any of these paths; BOOTSTRAP_SQL already declares all five
 * correctly. test/integration/db-migrations.spec.ts asserts fresh/upgraded parity.
 */
function migrateSessionZeroConsent600(sqlite: Database.Database): void {
  const tableExists = (name: string): boolean =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

  if (tableExists('session_zero')) {
    const columns = sqlite.prepare('PRAGMA table_info(session_zero)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'preview_policy')) {
      // CHECK must match BOOTSTRAP_SQL: upgraded installs otherwise accept any string
      // while fresh installs reject out-of-range values at the database level.
      sqlite.exec(
        "ALTER TABLE session_zero ADD COLUMN preview_policy TEXT NOT NULL DEFAULT 'boundaries' CHECK (preview_policy IN ('boundaries', 'full'))",
      );
    }
  }

  /** Drop a table whose shape predates this migration; leave a correct one alone. */
  const needsCreate = (table: string, expected: string[]): boolean => {
    if (!tableExists(table)) return true;
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (expected.every((c) => names.has(c))) return false;
    sqlite.exec(`DROP TABLE ${table}`);
    return true;
  };

  if (
    needsCreate('session_zero_charter_versions', [
      'id',
      'campaign_id',
      'version',
      'lines',
      'veils',
      'safety_tools',
      'house_rules',
      'tone_and_expectations',
      'material',
      'change_summary',
      'published_by',
      'published_at',
    ])
  ) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS session_zero_charter_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        lines TEXT NOT NULL DEFAULT '[]',
        veils TEXT NOT NULL DEFAULT '[]',
        safety_tools TEXT NOT NULL DEFAULT '[]',
        house_rules TEXT NOT NULL DEFAULT '',
        tone_and_expectations TEXT NOT NULL DEFAULT '',
        material INTEGER NOT NULL DEFAULT 0 CHECK (material IN (0, 1)),
        change_summary TEXT NOT NULL DEFAULT '',
        published_by TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL,
        UNIQUE(campaign_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_charter_versions_campaign
        ON session_zero_charter_versions(campaign_id, version);
    `);
  }

  if (
    needsCreate('session_zero_acknowledgments', [
      'id',
      'campaign_id',
      'version_id',
      'user_id',
      'user_name',
      'state',
      'note',
      'created_at',
      'updated_at',
    ])
  ) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS session_zero_acknowledgments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        version_id INTEGER NOT NULL REFERENCES session_zero_charter_versions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL CHECK (state IN ('acknowledged', 'discuss', 'declined')),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(version_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_charter_acks_version ON session_zero_acknowledgments(version_id);
      CREATE INDEX IF NOT EXISTS idx_charter_acks_campaign_user
        ON session_zero_acknowledgments(campaign_id, user_id);
    `);
  }

  if (
    needsCreate('session_zero_boundary_submissions', [
      'id',
      'campaign_id',
      'kind',
      'text',
      'anonymous',
      'submitter_user_id',
      'submitter_name',
      'created_at',
      'updated_at',
    ])
  ) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS session_zero_boundary_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('line', 'veil')),
        text TEXT NOT NULL,
        anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0, 1)),
        submitter_user_id TEXT NOT NULL,
        submitter_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_charter_boundary_campaign
        ON session_zero_boundary_submissions(campaign_id, id);
    `);
  }

  // Deliberately NO birth-date column, here or anywhere in this flow — see the table
  // comment in bootstrap.sql.ts and the assertion in test/unit/session-zero-consent.spec.ts.
  if (
    needsCreate('session_zero_guardian_consents', [
      'id',
      'campaign_id',
      'user_id',
      'user_name',
      'version_id',
      'guardian_name',
      'guardian_email',
      'guardian_relationship',
      'minor_attested',
      'status',
      'decision_note',
      'decided_at',
      'created_at',
      'updated_at',
    ])
  ) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS session_zero_guardian_consents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL DEFAULT '',
        version_id INTEGER NOT NULL REFERENCES session_zero_charter_versions(id) ON DELETE CASCADE,
        guardian_name TEXT NOT NULL DEFAULT '',
        guardian_email TEXT NOT NULL DEFAULT '',
        guardian_relationship TEXT NOT NULL DEFAULT '',
        minor_attested INTEGER NOT NULL DEFAULT 1 CHECK (minor_attested IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'declined', 'withdrawn')),
        decision_note TEXT NOT NULL DEFAULT '',
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_charter_guardian_campaign
        ON session_zero_guardian_consents(campaign_id, status);
    `);
  }
}

/**
 * Issue #598 — the incident trail for AI driver turns withheld by a provider content filter or
 * a model refusal.
 *
 * Purely additive: one new table plus its index, so the body is `CREATE ... IF NOT EXISTS` and
 * re-running it is a no-op. The `sqlite_master` / `PRAGMA table_info` probe is the belt for the
 * one case IF NOT EXISTS cannot cover — an install carrying an EARLIER shape of the table from
 * a pre-release build of this branch. Dropping in that case is deliberate and cheap: the rows
 * are an operational review trail of counts, never campaign canon, and the alternative
 * (guessing which columns to ALTER in) is how a half-migrated table ships.
 *
 * Note what is NOT here: any column that could hold the withheld text. See the schema comment.
 */
function migrateAiDriverWithheldTurns598(sqlite: Database.Database): void {
  const existing = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_driver_withheld_turns'`)
    .all();
  if (existing.length > 0) {
    const cols = sqlite.prepare(`PRAGMA table_info(ai_driver_withheld_turns)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const expected = [
      'id',
      'campaign_id',
      'turn',
      'step',
      'finish_reason',
      'provider',
      'model',
      'withheld_chars',
      'released_chars',
      'suppressed_tool_calls',
      'triggered_by_user_id',
      'created_at',
    ];
    if (expected.every((c) => names.has(c))) return;
    sqlite.exec(`DROP TABLE ai_driver_withheld_turns`);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_driver_withheld_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      turn INTEGER NOT NULL,
      step INTEGER NOT NULL,
      finish_reason TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      withheld_chars INTEGER NOT NULL DEFAULT 0,
      released_chars INTEGER NOT NULL DEFAULT 0,
      suppressed_tool_calls INTEGER NOT NULL DEFAULT 0,
      triggered_by_user_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_driver_withheld_campaign
      ON ai_driver_withheld_turns(campaign_id, id);
  `);
}

/**
 * Issue #587: server-admin campaign metadata catalog.
 *
 * Two independent pieces, both idempotent and both probe-before-act:
 *
 *  1. `campaigns.catalog_privacy` — a campaign's OWN opt-out from having its name and
 *     description disclosed in the catalog. NOT NULL DEFAULT 'inherit', so the ADD COLUMN
 *     backfills every existing row to the server-default-following value in one statement
 *     (SQLite materialises a constant non-null default for existing rows on ALTER TABLE
 *     ADD COLUMN, and 'inherit' is constant). No table rebuild. No REFERENCES clause is
 *     involved, so the #69 convention about omitting FKs on ALTER does not apply here.
 *
 *  2. `campaign_export_requests` — an operator's ASK that a campaign's DMs produce an
 *     export. Brand-new table, so the current house style (see
 *     migrateAiDriverGroundingClaims577 above) applies: probe sqlite_master, verify the
 *     expected column set, and DROP/recreate only if an earlier partial shape is found.
 *     A pre-existing table carrying all expected columns is left completely alone.
 *
 *     ONE WAY THIS TABLE IS NOT LIKE ITS MODEL. The DROP/recreate convention is borrowed
 *     from migrateAiDriverGroundingClaims577, but that table holds derived, audit-style
 *     claims that can be recomputed; this one holds DM CONSENT DECISIONS — who was asked
 *     to hand over a campaign's contents, why, and what the DM answered. Recreating it
 *     DESTROYS that record, and nothing can reconstruct it.
 *
 *     The branch is unreachable in practice: only a partial pre-release install of this
 *     same feature can leave a `campaign_export_requests` with the wrong shape, and such
 *     a table has no real decisions in it. So the convention is kept rather than traded
 *     for a column-by-column rebuild that would exist solely for a state no shipped
 *     version can be in. But the analogy is doing less work than it looks like it is:
 *     if this table ever needs a shape change AFTER release, that migration must
 *     preserve the rows rather than inherit this branch.
 *
 * Fresh DBs never take either path — BOOTSTRAP_SQL already declares both correctly. The
 * classic failure for this convention is bootstrap.sql and the migration drifting apart,
 * leaving an upgraded install with a subtly different table than a fresh one;
 * test/integration/db-migrations.spec.ts asserts fresh/upgraded parity for both pieces.
 */
function migrateAdminCampaignCatalog587(sqlite: Database.Database): void {
  const hasCampaigns = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
    .get();
  if (hasCampaigns) {
    const columns = sqlite.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'catalog_privacy')) {
      sqlite.exec("ALTER TABLE campaigns ADD COLUMN catalog_privacy TEXT NOT NULL DEFAULT 'inherit'");
    }
  }

  const existing = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_export_requests'")
    .all();
  if (existing.length > 0) {
    const cols = sqlite.prepare('PRAGMA table_info(campaign_export_requests)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const expected = [
      'id',
      'campaign_id',
      'requested_by',
      'requested_by_user_id',
      'profile',
      'justification',
      'status',
      'decided_by',
      'decided_at',
      'decision_note',
      'created_at',
      'updated_at',
    ];
    if (expected.every((c) => names.has(c))) return;
    sqlite.exec('DROP TABLE campaign_export_requests');
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_export_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL DEFAULT '',
      justification TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_export_requests_campaign
      ON campaign_export_requests(campaign_id, id);
    CREATE INDEX IF NOT EXISTS idx_campaign_export_requests_status
      ON campaign_export_requests(status, id);
  `);
}

/**
 * Issue #1052 — an OPTIONAL FALLBACK provider config per scope.
 *
 * Two edits, and the second is the one that matters. Adding `role` is a plain ADD COLUMN with
 * a default, so every existing row becomes the 'primary' it always was. But the pre-existing
 * partial uniques —
 *     UNIQUE(scope)       WHERE scope = 'server'
 *     UNIQUE(campaign_id) WHERE campaign_id IS NOT NULL
 * — permit exactly ONE row per scope, which makes a fallback row impossible to insert. They
 * are dropped and recreated keyed on (…, role).
 *
 * DROP + CREATE rather than editing the original DDL in place: `CREATE UNIQUE INDEX IF NOT
 * EXISTS` is a no-op against a database that already has an index of that name, so editing
 * migration 0040's body would silently leave every existing install on the old
 * one-row-per-scope constraint while fresh installs got the new one. The index NAMES change
 * too (`…_server` → `…_server_role`), so a half-applied state cannot masquerade as complete.
 *
 * Idempotent and safe to re-run: the column is probed for, and DROP INDEX IF EXISTS is a
 * no-op. Widening a unique index can never fail on existing data — every row satisfying the
 * old, stricter constraint satisfies the new one.
 */
function migrateAiProviderConfigFallbackRole1052(sqlite: Database.Database): void {
  const tableExists =
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_provider_configs'").get() != null;
  // A fresh DB gets the whole shape from BOOTSTRAP_SQL; there is nothing to migrate.
  if (!tableExists) return;

  const cols = (sqlite.prepare('PRAGMA table_info(ai_provider_configs)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (!cols.includes('role')) {
    sqlite.exec("ALTER TABLE ai_provider_configs ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'");
  }

  sqlite.exec(`
    DROP INDEX IF EXISTS idx_ai_provider_configs_server;
    DROP INDEX IF EXISTS idx_ai_provider_configs_campaign;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_server_role
      ON ai_provider_configs(scope, role) WHERE scope = 'server';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_configs_campaign_role
      ON ai_provider_configs(campaign_id, role) WHERE campaign_id IS NOT NULL;
  `);
}

/**
 * Issue #599 — the table safety hold (X-Card): one row per campaign carrying whether play
 * is frozen right now, plus who released the last hold and how.
 *
 * Purely additive (one new table, no index — every access is the PK lookup), so the body is
 * `CREATE TABLE IF NOT EXISTS` and re-running it is a no-op. The `sqlite_master` /
 * `PRAGMA table_info` probe is the belt for the case IF NOT EXISTS cannot cover: an install
 * carrying an EARLIER shape of this table. Dropping in that case is deliberate and safe here
 * in a way it would not be for campaign canon — the row is live table state, and the only
 * consequence of losing it is that a campaign which was mid-hold comes back un-held. That is
 * visible and instantly recoverable (any participant simply taps again), unlike the silently
 * half-migrated table that guessing at ALTERs produces.
 *
 * The table is deliberately not append-only and deliberately has no activated_by_user_id;
 * see the rationale comments in bootstrap.sql.ts and db/schema.ts.
 */
function migrateTableSafetyHolds599(sqlite: Database.Database): void {
  const existing = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='table_safety_holds'`)
    .all();
  if (existing.length > 0) {
    const cols = sqlite.prepare(`PRAGMA table_info(table_safety_holds)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    const expected = [
      'campaign_id',
      'active',
      'activated_at',
      'activated_by_name',
      'anonymous',
      'activation_count',
      'released_at',
      'released_by',
      'recovery',
      'facilitator_note',
      'updated_at',
    ];
    if (expected.every((c) => names.has(c))) return;
    sqlite.exec(`DROP TABLE table_safety_holds`);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS table_safety_holds (
      campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 0,
      activated_at TEXT,
      activated_by_name TEXT,
      anonymous INTEGER NOT NULL DEFAULT 1,
      activation_count INTEGER NOT NULL DEFAULT 0,
      released_at TEXT,
      released_by TEXT,
      recovery TEXT,
      facilitator_note TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

/** Fresh installs receive this via bootstrap; upgrades need the same clean taxonomy tables. */
function migrateCampaignLibraryManagement742(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS campaign_library_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', color TEXT NOT NULL DEFAULT '#64748b', description TEXT NOT NULL DEFAULT '',
      parent_tag_id INTEGER REFERENCES campaign_library_tags(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id, name));
    CREATE INDEX IF NOT EXISTS idx_campaign_library_tags_campaign ON campaign_library_tags(campaign_id);
    CREATE TABLE IF NOT EXISTS campaign_library_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', color TEXT NOT NULL DEFAULT '#64748b', description TEXT NOT NULL DEFAULT '',
      parent_collection_id INTEGER REFERENCES campaign_library_collections(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id, name));
    CREATE INDEX IF NOT EXISTS idx_campaign_library_collections_campaign ON campaign_library_collections(campaign_id);
    CREATE TABLE IF NOT EXISTS campaign_library_entity_taxonomy (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      tag_id INTEGER REFERENCES campaign_library_tags(id) ON DELETE CASCADE, collection_id INTEGER REFERENCES campaign_library_collections(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      CHECK ((tag_id IS NOT NULL) != (collection_id IS NOT NULL)));
    CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_library_entity_tag ON campaign_library_entity_taxonomy(campaign_id, entity_type, entity_id, tag_id) WHERE tag_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_library_entity_collection ON campaign_library_entity_taxonomy(campaign_id, entity_type, entity_id, collection_id) WHERE collection_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_campaign_library_entity_taxonomy_entity ON campaign_library_entity_taxonomy(campaign_id, entity_type, entity_id);
    CREATE TABLE IF NOT EXISTS campaign_library_bulk_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, actor TEXT NOT NULL, operation TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, inverse_json TEXT NOT NULL, undone_at TEXT, undone_by TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaign_library_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', snapshot_json TEXT NOT NULL, source_entity_id INTEGER, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_campaign_library_templates_campaign ON campaign_library_templates(campaign_id, entity_type, archived_at);
  `);
}

/**
 * Issue #1047: sheet-scoped condition metadata.
 *
 * Adds `characters.condition_instances`, the counterpart to the `combatants` column #423
 * added. NULLABLE on purpose, and deliberately NOT backfilled: every existing row holds
 * bare strings in `conditions`, and the read path (common/conditions.ts
 * readConditionInstances) materialises those into instances on demand. A backfill would
 * rewrite every character row on upgrade to produce data the reader already derives, and
 * would then have to be kept in step with the reader forever.
 *
 * So an install with years of bare strings reads exactly as it did before, and only gains
 * structure when something actually writes metadata. Nothing here can lose a condition:
 * the legacy column is untouched.
 *
 * Probe-before-act per house style — ADD COLUMN is not idempotent on its own.
 */
function migrateCharacterConditionInstances1047(sqlite: Database.Database): void {
  const hasCharacters = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'")
    .get();
  if (!hasCharacters) return;
  const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'condition_instances')) return;
  sqlite.exec('ALTER TABLE characters ADD COLUMN condition_instances TEXT');
}

/** Issue #735: current attachment provenance fields. Additive only; no legacy format shim. */
function migrateAttachmentMetadata735(sqlite: Database.Database): void {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'").get();
  if (!exists) return;
  const columns = new Set((sqlite.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>).map((c) => c.name));
  const additions: Array<[string, string]> = [
    ['title', "TEXT NOT NULL DEFAULT ''"], ['caption', "TEXT NOT NULL DEFAULT ''"], ['alt_text', "TEXT NOT NULL DEFAULT ''"],
    ['creator', "TEXT NOT NULL DEFAULT ''"], ['source_url', "TEXT NOT NULL DEFAULT ''"], ['license', "TEXT NOT NULL DEFAULT ''"],
    ['rights', "TEXT NOT NULL DEFAULT ''"], ['attribution', "TEXT NOT NULL DEFAULT ''"], ['checksum_sha256', 'TEXT'],
  ];
  for (const [name, definition] of additions) if (!columns.has(name)) sqlite.exec(`ALTER TABLE attachments ADD COLUMN ${name} ${definition}`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS attachment_metadata_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_attachment_metadata_revisions_attachment ON attachment_metadata_revisions(attachment_id, id);`);
}

/** Issue #761 — additive current-format map batch/formation persistence. */
function migrateEncounterTokenBatches761(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS encounter_token_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, actor_id TEXT NOT NULL, preview_token TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'previewed', before_json TEXT NOT NULL,
      plan_json TEXT NOT NULL, after_json TEXT, result_json TEXT, apply_key TEXT, undo_key TEXT, created_at TEXT NOT NULL, applied_at TEXT, undone_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_encounter_token_batches_encounter ON encounter_token_batches(encounter_id);
    CREATE TABLE IF NOT EXISTS campaign_token_formations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, name TEXT NOT NULL, layout_json TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(campaign_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_token_formations_campaign ON campaign_token_formations(campaign_id);
  `);
  // Repair older tables that predate apply_key/undo_key before the unique indexes reference them.
  const cols = sqlite.prepare(`PRAGMA table_info(encounter_token_batches)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'apply_key')) sqlite.exec('ALTER TABLE encounter_token_batches ADD COLUMN apply_key TEXT');
  if (!cols.some(c => c.name === 'undo_key')) sqlite.exec('ALTER TABLE encounter_token_batches ADD COLUMN undo_key TEXT');
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_encounter_token_batches_actor_apply ON encounter_token_batches(actor_id, apply_key) WHERE apply_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_encounter_token_batches_actor_undo ON encounter_token_batches(actor_id, undo_key) WHERE undo_key IS NOT NULL;
  `);
}

const MIGRATIONS: ReadonlyArray<{ name: string; run: (sqlite: Database.Database) => void }> = [
  { name: '0001_users_oidc', run: migrateUsersTableForOidc },
  { name: '0002_campaigns_rule_system', run: migrateCampaignsTableForRuleSystem },
  { name: '0003_users_accent_color', run: migrateUsersTableForAccentColor },
  { name: '0004_users_text_size', run: migrateUsersTableForTextSize },
  { name: '0005_campaigns_map_attachment', run: migrateCampaignsTableForMapAttachment },
  { name: '0006_api_tokens_admin_enabled', run: migrateApiTokensTableForAdminEnabled },
  { name: '0007_api_tokens_write_scope', run: migrateApiTokensTableForWriteScope },
  { name: '0008_proposals_snapshot', run: migrateProposalsTableForSnapshot },
  { name: '0009_proposals_attribution', run: migrateProposalsTableForAttribution },
  { name: '0010_characters_sheet_depth', run: migrateCharactersTableForSheetDepth },
  { name: '0011_campaigns_ics_token', run: migrateCampaignsTableForIcsToken },
  { name: '0012_campaigns_storage_quota', run: migrateCampaignsTableForStorageQuota },
  { name: '0013_characters_xp', run: migrateCharactersTableForXp },
  { name: '0014_characters_status', run: migrateCharactersTableForStatus },
  { name: '0015_characters_dm_secret', run: migrateCharactersTableForDmSecret },
  { name: '0016_notes_recipient', run: migrateNotesTableForRecipient },
  { name: '0017_sessions_dm_secret', run: migrateSessionsTableForDmSecret },
  { name: '0018_encounters_current_combatant', run: migrateEncountersTableForCurrentCombatant },
  { name: '0019_encounters_links', run: migrateEncountersTableForLinks },
  { name: '0020_encounters_map_attachment', run: migrateEncountersTableForMapAttachment },
  { name: '0021_combatants_hp_model', run: migrateCombatantsTableForHpModel },
  { name: '0022_combatants_token_position', run: migrateCombatantsTableForTokenPosition },
  { name: '0023_quests_hidden', run: migrateQuestsTableForHidden },
  { name: '0024_npcs_hidden', run: migrateNpcsTableForHidden },
  { name: '0025_attachments_hidden', run: migrateAttachmentsTableForHidden },
  { name: '0026_locations_parent_id', run: migrateLocationsTableForParentId },
  { name: '0027_rule_entries_source', run: migrateRuleEntriesTableForSource },
  { name: '0028_dice_rolls_keep_drop', run: migrateDiceRollsTableForKeepDrop },
  { name: '0029_encounters_vtt_grid_fog', run: migrateEncountersTableForVtt },
  { name: '0030_combatants_token_size', run: migrateCombatantsTableForTokenSize },
  { name: '0031_soft_delete', run: migrateSoftDeleteColumns },
  { name: '0032_npcs_faction_id', run: migrateNpcsTableForFactionId },
  { name: '0033_encounters_aoe_hex', run: migrateEncountersTableForAoeHex },
  { name: '0034_campaigns_dm_controls_progression', run: migrateCampaignsTableForDmControlsProgression },
  { name: '0035_encounters_hidden', run: migrateEncountersTableForHidden },
  { name: '0036_story_beats_links', run: migrateStoryBeatsTableForLinks },
  { name: '0037_npcs_icon_slug', run: migrateNpcsTableForIconSlug },
  { name: '0038_rule_entries_icon_slug', run: migrateRuleEntriesTableForIconSlug },
  { name: '0039_inventory_items_icon_slug', run: migrateInventoryItemsTableForIconSlug },
  { name: '0040_ai_provider_config', run: migrateAiProviderConfigTable },
  { name: '0041_ai_dm_seats_mode', run: migrateAiDmSeatsTableForMode },
  { name: '0043_ai_scribe_jobs', run: migrateAiScribeTables },
  { name: '0044_combatants_npc_id', run: migrateCombatantsTableForNpcId },
  { name: '0045_comments_soft_delete', run: migrateCommentsTableForSoftDelete },
  { name: '0046_campaign_members_user_fk', run: migrateCampaignMembersTableForUserFk },
  { name: '0047_comments_editor_provenance', run: migrateCommentsTableForEditorProvenance },
  { name: '0048_dice_rolls_terms', run: migrateDiceRollsTableForTerms },
  { name: '0049_campaigns_ics_token_expires_at', run: migrateCampaignsTableForIcsTokenExpiresAt },
  { name: '0050_rule_entries_licensing', run: migrateRuleEntriesTableForLicensing },
  { name: '0051_server_meta', run: migrateServerMetaTable },

  { name: '0052_public_recap_share_policy', run: migratePublicRecapSharePolicy },
  { name: '0053_oauth_atomic_rotation', run: migrateOAuthAccessTokensForAtomicRotation },
  { name: '0054_combatants_unique_identity', run: migrateCombatantsUniqueIdentity },
  { name: '0055_participant_support_preferences', run: migrateParticipantSupportPreferences },
  { name: '0056_characters_death_temp_hp', run: migrateCharactersTableForDeathTempHp },
  { name: '0057_campaigns_active_encounter', run: migrateCampaignsTableForActiveEncounter },
  { name: '0058_campaigns_public_invites_enabled', run: migrateCampaignsTableForPublicInvitesEnabled },
  { name: '0059_public_invites_disabled_inactive', run: migratePublicInvitesDisabledForInactiveCampaigns },
  { name: '0060_encounter_events_combatant_ids', run: migrateEncounterEventsTableForCombatantIds },
  { name: '0061_combatants_sheet_synced_updated_at', run: migrateCombatantsTableForSheetSyncedUpdatedAt },
  { name: '0062_attachments_publication_state', run: migrateAttachmentsTableForPublicationState },
  { name: '0063_comments_character_attribution', run: migrateCommentsTableForCharacterAttribution },
  { name: '0064_encounter_links_campaign_scope', run: migrateEncounterLinksCampaignScope },
  { name: '0065_notifications_comment_id', run: migrateNotificationsTableForCommentId },
  { name: '0066_entity_revisions_version_authorship', run: migrateEntityRevisionsForVersionAuthorship },
  { name: '0067_campaign_members_exclusive_character', run: migrateCampaignMembersExclusiveCharacter },
  { name: '0068_inventory_qty_idempotency', run: migrateInventoryQtyIdempotencyTable },
  { name: '0069_inventory_qty_idempotency_created_at', run: migrateInventoryQtyIdempotencyCreatedAtIndex },
  { name: '0070_notifications_data', run: migrateNotificationsTableForData },
  { name: '0071_ai_dm_usage_history', run: migrateAiDmUsageHistoryTable },
  { name: '0072_combatants_turn_state', run: migrateCombatantsTableForTurnState },
  { name: '0073_campaigns_turn_controls', run: migrateCampaignsTableForTurnControls },
  { name: '0074_encounters_grid_calibration', run: migrateEncountersTableForGridCalibration },
  { name: '0075_check_requests', run: migrateCheckRequestsTable },
  { name: '0076_campaign_purge_tombstones', run: migrateCampaignPurgeTombstones },
  { name: '0077_combatants_initiative_group', run: migrateCombatantsTableForInitiativeGroup },
  { name: '0079_notification_preferences', run: migrateNotificationPreferencesTables },
  { name: '0080_starfinder_combat_state', run: migrateStarfinderCombatState },
  { name: '0081_ai_dm_seats_action_queue_depth', run: migrateAiDmSeatsTableForActionQueueDepth },
  { name: '0082_ai_dm_seats_proactive_settings', run: migrateAiDmSeatsTableForProactiveSettings },
  { name: '0083_users_time_format', run: migrateUsersTableForTimeFormat },
  { name: '0084_hot_history_composite_indexes', run: migrateHotHistoryCompositeIndexes },
  { name: '0085_combatants_condition_instances', run: migrateCombatantsTableForConditionInstances },
  { name: '0086_encounters_boss_turn_phase', run: migrateEncountersTableForBossTurnPhase },
  { name: '0087_campaigns_narration_language', run: migrateCampaignsTableForNarrationLanguage },
  { name: '0088_users_dice_theme', run: migrateUsersTableForDiceTheme },
  { name: '0089_characters_resources', run: migrateCharactersTableForResources },
  { name: '0090_trash_soft_delete_701', run: migrateTrashSoftDeleteColumns701 },
  { name: '0091_audit_log_request_id', run: migrateAuditLogForRequestId },
  { name: '0092_dice_rolls_manual_provenance', run: migrateDiceRollsTableForManualProvenance },
  { name: '0093_proposals_base_snapshot', run: migrateProposalsTableForBaseSnapshot },
  { name: '0094_inventory_items_soft_delete', run: migrateInventoryItemsTableForSoftDelete },
  { name: '0095_campaign_catch_up_cursors', run: migrateCampaignCatchUpCursorsTable },
  { name: '0096_encounter_events_provenance', run: migrateEncounterEventsTableForProvenance },
  { name: '0097_npcs_portrait_url', run: migrateNpcsTableForPortraitUrl },
  { name: '0098_encounters_aftermath_dismissed', run: migrateEncountersTableForAftermathDismissed },
  { name: '0099_encounters_hex_orientation', run: migrateEncountersTableForHexOrientation },
  { name: '0100_factions_portrait_url', run: migrateFactionsTableForPortraitUrl },
  { name: '0101_locations_portrait_url', run: migrateLocationsTableForPortraitUrl },
  { name: '0102_ai_scribe_session_scope_499', run: migrateAiScribeSessionScope499 },
  { name: '0103_combatants_statblock_json', run: migrateCombatantsTableForStatblockJson },
  { name: '0104_campaign_library_monsters', run: migrateCampaignLibraryMonstersTable },
  { name: '0105_campaign_library_monsters_fk', run: migrateCampaignLibraryMonstersForeignKeys },
  { name: '0106_guest_dm_handoff_545', run: migrateGuestDmHandoff545 },
  { name: '0107_archmage_escalation_542', run: migrateArchmageEscalation542 },
  { name: '0108_ai_dm_token_reservations_563', run: migrateAiDmSeatsTableForTokenReservations },
  { name: '0109_cast_sessions_547', run: migrateCastSessionsTable },
  // 0108/0109 both landed on main while this branch was open; derivatives take 0110.
  { name: '0110_attachment_derivatives_604', run: migrateAttachmentDerivativesTable604 },
  // 0108/0109 were claimed on main by the AI token-reservation (#563) and cast-session
  // (#547) migrations, and 0110 by attachment derivatives (#604); this branch merges
  // after all of them, so the scheduling lifecycle migration takes the next genuinely
  // free ordinal rather than collide.
  { name: '0111_scheduling_lifecycle_504', run: migrateSchedulingLifecycle504 },
  // The 0112-0113 gap is permanent, not a miscount. Those ordinals were held for branches
  // that ultimately landed elsewhere (#559 took 0118/0119), so nothing will ever claim
  // them. Ordinals were allocated centrally across concurrent branches — 0114 → #501,
  // 0115 → #572, 0116 → #580, 0117 → #601 — precisely so several branches would not each
  // compute "next free" in parallel and collide.
  //
  // The numbers are presentational: `runMigrations` applies entries in ARRAY order and
  // dedupes on the FULL name string, so the issue-number suffix is what actually
  // guarantees each runs exactly once. That is also why nothing here is ever renumbered
  // to look tidy — renaming a migration a database has already recorded is the one edit
  // that silently breaks run-once.
  { name: '0114_ai_consent_provenance_501', run: migrateAiConsentAndProvenance501 },
  { name: '0115_ai_dm_transcript_events_572', run: migrateAiDmTranscriptEventsTable572 },
  { name: '0116_encounter_op_idempotency_580', run: migrateEncounterOpIdempotency580 },
  // #559 deliberately skips past the contested 0112-0117 band rather than taking the next free
  // ordinal: this pair has already been renumbered three times by other branches landing first,
  // and 0114-0117 are spoken for by #501/#572/#580/#601, any of which may merge before this.
  //
  // Two invariants, both load-bearing:
  //   1. These two stay ADJACENT and IN THIS ORDER — create table, then add the column.
  //   2. Both names must be NEVER-BEFORE-RECORDED. runMigrations skips by exact name string, so
  //      reusing a name any DB already recorded silently skips the migration and the column is
  //      never added. This pair has previously shipped as 0107/0108/0111/0112 (create) and
  //      0112/0113 (backfill); 0118/0119 collide with none of them.
  { name: '0118_ai_driver_control_state_559', run: migrateAiDriverControlStateTable },
  { name: '0119_ai_driver_control_state_announced_recovery_559', run: migrateAiDriverControlStateAnnouncedRecovery },
  // 0112-0115 stay centrally allocated to other in-flight branches (0112/0113 → #1442,
  // 0114 → #501, 0115 → #572), so this migration takes 0117 rather than computing
  // "next free" for itself — parallel branches all computing that independently is how
  // they collide.
  //
  // It sits BELOW #559's 0118/0119 in the array despite the lower ordinal: #559 reached
  // main first, so the merge keeps main's entries ahead of this branch's. Execution order
  // between them is immaterial — they touch disjoint tables — and the ordinal is a
  // readability convention only. What actually guarantees run-once is the full NAME
  // string, which `runMigrations` dedupes on; that is exactly why this is NOT renumbered
  // to 0120 to look tidy, since renaming a migration a database has already recorded is
  // the one edit that would break run-once behaviour.
  { name: '0117_moderation_incidents_601', run: migrateModerationIncidents601 },
  // 0121 was CENTRALLY ALLOCATED to issue #577 by the merge coordinator; 0112-0120 are held
  // by other in-flight branches, so the gap above is deliberate and must not be "tidied" into
  // the next free ordinal. runMigrations dedupes on the FULL name string, so the `_577` suffix
  // is what guarantees this runs exactly once even if a sibling branch lands a colliding ordinal.
  { name: '0121_ai_driver_grounding_claims_577', run: migrateAiDriverGroundingClaims577 },
  // 0131 was CENTRALLY ALLOCATED to issue #1042 by the merge coordinator. 0122-0130 are held by
  // other in-flight branches (0130 → #599), so the gap is deliberate and must not be tidied down
  // to the next free ordinal — every branch computing "next free" for itself is how they collide.
  //
  // This must stay AFTER 0118 (`ai_driver_control_state` CREATE) in the array: it ALTERs that
  // table, and runMigrations executes in array order. The name is never-before-recorded, which
  // is what actually guarantees run-once — runMigrations dedupes on the FULL string, so the
  // `_1042` suffix survives a sibling branch landing a colliding ordinal, and renaming it later
  // is the one edit that would silently skip it on every database that already recorded it.
  { name: '0131_ai_driver_session_persistence_1042', run: migrateAiDriverSessionPersistence1042 },
  // 0133 was CENTRALLY ALLOCATED to issue #1043 by the merge coordinator; 0130/0131/0132 are held
  // by other in-flight branches, so the gap is deliberate and must not be tidied down to the next
  // free ordinal — every branch computing "next free" for itself is how they collide.
  //
  // Must stay AFTER 0118 (the CREATE) in the array: runMigrations executes in array order, and an
  // ALTER against a table that does not exist yet is a no-op that never retries. Run-once is
  // guaranteed by the FULL name string, which is why the `_1043` suffix matters and why renaming
  // this later would silently skip it on every database that already recorded it.
  { name: '0133_ai_session_phase_1043', run: migrateAiDriverSessionPhase1043 },
  // 0138 was CENTRALLY ALLOCATED to issue #1051 by the merge coordinator; the ordinals below it
  // are held by other in-flight branches, so the gap is deliberate and must not be tidied down to
  // the next free one. Must stay AFTER 0118 (the CREATE) in the array — runMigrations goes in
  // array order and an ALTER against a missing table is a no-op that never retries. Run-once is
  // guaranteed by the FULL name string, which is why the `_1051` suffix matters.
  { name: '0138_ai_collaborative_handoff_1051', run: migrateAiDriverCollaborative1051 },
  // Campaign modules take 0120, assigned centrally. The 0114/0115 this branch originally
  // carried were reassigned to #1443 and #1524 as those landed first; 0112/0113 are a
  // permanent gap, since the branch holding them ended up taking 0118/0119.
  //
  // Note 0117 (#601) sits ABOVE 0118/0119 (#559) in the array despite the lower number —
  // merge order, not a mistake. `runMigrations` applies entries in ARRAY order and dedupes
  // on the FULL name, so ordinals are presentational and need only be unique, never
  // contiguous or sorted. That is also why nothing is renumbered to look tidy: renaming a
  // migration a database has already recorded is the one edit that breaks run-once.
  { name: '0120_campaign_modules_585', run: migrateCampaignModules585 },
  // 0127 was CENTRALLY ALLOCATED to issue #597; 0122-0126 are held by other in-flight
  // branches, so the gap above is deliberate and must not be "tidied" into the next
  // free ordinal. runMigrations dedupes on the FULL name string — renaming this entry
  // on a database that has already recorded it would silently re-run the grandfather
  // backfill against seats a DM may since have deliberately revoked.
  { name: '0127_safety_controls_597', run: migrateSafetyControls597 },
  // 0126 was CENTRALLY ALLOCATED to issue #587 by the merge coordinator; 0122-0125 are held
  // by other in-flight branches, so the gap above is deliberate and must not be "tidied" down
  // to the next free ordinal. runMigrations dedupes on the FULL name string, so the `_587`
  // suffix is what guarantees this runs exactly once even if a sibling branch lands a
  // colliding ordinal — and renaming this entry after a database has recorded it is the one
  // edit that silently re-runs it.
  { name: '0126_admin_campaign_catalog_587', run: migrateAdminCampaignCatalog587 },
  // #600 was independently allocated the same 0127 ordinal, and both entries arrived in
  // the same merge. The collision is harmless and is deliberately NOT renumbered:
  // runMigrations applies entries in ARRAY order and dedupes on the FULL name string, so
  // `0127_safety_controls_597` and `0127_session_zero_consent_600` are distinct records
  // and each still runs exactly once. Renaming either after a database has recorded it is
  // the one edit that would silently re-run it.
  { name: '0127_session_zero_consent_600', run: migrateSessionZeroConsent600 },
  // 0129 was CENTRALLY ALLOCATED to issue #598 by the merge coordinator. 0122-0128 are held by
  // other in-flight branches, so the gap above is deliberate and must NOT be "tidied" into the
  // next free ordinal — several branches each computing "next free" in parallel is precisely
  // how they collide. runMigrations applies entries in ARRAY order and dedupes on the FULL name
  // string, so the `_598` suffix is what actually guarantees this runs exactly once, and
  // renaming it later (a database that already recorded this name would silently skip it) is
  // the one edit that breaks run-once.
  { name: '0129_ai_driver_withheld_turns_598', run: migrateAiDriverWithheldTurns598 },
  // 0130 was CENTRALLY ALLOCATED to issue #599 by the merge coordinator. 0122-0129 are held by
  // other in-flight branches, so the gap above is deliberate and must not be "tidied" down to
  // the next free ordinal — every branch computing "next free" for itself is exactly how these
  // collide. runMigrations dedupes on the FULL name string, so the `_599` suffix is what
  // guarantees this runs exactly once even if a sibling lands a colliding ordinal, and it is
  // why this is never renumbered: renaming a migration a database has already recorded is the
  // one edit that silently breaks run-once.
  { name: '0130_table_safety_holds_599', run: migrateTableSafetyHolds599 },
  // 0134 was CENTRALLY ALLOCATED to issue #1049 by the merge coordinator; 0126-0133 were held by
  // other in-flight branches when this entry was written. Several have since landed and are
  // registered in this same array (0130 → #599, 0131 → #1042, 0132 → #1047), which changes
  // nothing: the gap above is still deliberate and must not be "tidied" down to the next free
  // ordinal. As with 0121 and 0117, ordinals are presentational — `runMigrations` applies
  // entries in ARRAY order and dedupes on the FULL name string, so the `_1049` suffix is what
  // guarantees this runs exactly once even if a sibling branch lands a colliding number.
  // Renaming it after a database has recorded it is the one edit that would break run-once.
  { name: '0134_ai_seat_style_presets_1049', run: migrateAiDmSeatsTableForStylePresets1049 },
  // 0123/0124 are CENTRALLY ALLOCATED to this branch by the merge coordinator.
  // 0112-0122 are held by other in-flight branches, so the gap above is deliberate
  // and these are NOT "the next free ordinal" — do not renumber them to close it.
  // runMigrations dedupes on the FULL name, so the `_588` suffix is what actually
  // guarantees run-once even if a sibling branch lands a colliding ordinal first.
  // The pair must stay adjacent and in this order: 0124 backfills a column 0123 adds.
  // They sit below main's entries because main reached the merge base first; execution
  // order between them is immaterial — 0130 touches `table_safety_holds` and 0123/0124
  // touch the organized-play tables and `scheduled_sessions`, which are disjoint.
  { name: '0123_organized_play_588', run: migrateOrganizedPlay588 },
  { name: '0124_organized_play_ics_uid_backfill_588', run: migrateOrganizedPlayIcsUidBackfill588 },
  // 0132 was CENTRALLY ALLOCATED to issue #1047 by the merge coordinator; the gap above is
  // deliberate and must not be "tidied" down to the next free ordinal. runMigrations dedupes
  // on the FULL name string, so the `_1047` suffix is what guarantees this runs exactly once
  // even if a sibling branch lands a colliding ordinal.
  { name: '0132_character_condition_instances_1047', run: migrateCharacterConditionInstances1047 },
  // 0135 was CENTRALLY ALLOCATED to this issue. 0126-0134 are held by other in-flight
  // branches (0126 #587, 0127 #597, 0129 #598, 0130 #599, 0131 #1042, 0132 #1022, 0133 #1043,
  // 0134 #1049), so the gap above is deliberate and must not be "tidied" into the next free
  // ordinal — several branches each computing "next free" in parallel is exactly how they
  // collide, and this entry was itself renumbered off 0130 for that reason before it merged.
  //
  // `runMigrations` dedupes on the FULL name string, so two entries sharing an ordinal would
  // both still run correctly; the ordinal is there so a HUMAN can read this array in order,
  // which is precisely the property a duplicate destroys. Renaming after a database has
  // recorded the name is the one edit that breaks run-once, which is why this could only be
  // fixed pre-merge.
  //
  // This one is NOT purely additive, unlike its neighbours: it REPLACES two partial unique
  // indexes. It must therefore never be reordered above 0040, which creates the originals.
  { name: '0135_ai_provider_config_fallback_role_1052', run: migrateAiProviderConfigFallbackRole1052 },
  { name: '0136_campaign_homebrew_741', run: migrateCampaignHomebrew741 },
  // #735 is additive but belongs at the execution tail: attachment provenance is
  // independent of earlier table work and migration arrays are read chronologically.
  { name: '0137_attachment_metadata_735', run: migrateAttachmentMetadata735 },
  // #738: additive inventory provenance columns; 0139 avoids colliding with
  // 0137 (#735) and 0138 (#1051) already used earlier in this array.
  { name: '0139_inventory_compendium_738', run: migrateInventoryItemsCompendium738 },
  // #1644 reached this branch as 0139, but main now owns that ordinal for #738.
  // This migration has not shipped on main, so keep the feature and give it the
  // next unique recorded name rather than creating a duplicate human-facing ordinal.
  { name: '0140_inbox_sweep_1644', run: migrateInboxSweepTables1644 },
  // #742 campaign-owned taxonomy, bulk journals, and current-format templates.
  // 0141: main claimed 0140 for inbox sweep (#1644) after this branch's earlier 0140.
  { name: '0141_campaign_library_management_742', run: migrateCampaignLibraryManagement742 },
  { name: '0142_encounter_token_batches_761', run: migrateEncounterTokenBatches761 },
  { name: '0143_party_rest_batches_759', run: migratePartyRestBatches759 },
];

/**
 * Create the schema-version table if absent. `__migrations` records the name of
 * every applied migration so the ordered steps in MIGRATIONS become recorded,
 * idempotent, run-once operations instead of unconditional every-boot probes.
 */
function ensureMigrationsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Create the single-row metadata table if absent (issue #726). `__db_meta` carries
 * the app version that last booted (and therefore last migrated) this database, so
 * a subsequently booted OLDER binary can detect it is running against a schema
 * touched by a newer app version and refuse to start — rather than silently writing
 * into a DB whose shape it does not understand. `key` is the singleton PRIMARY KEY
 * (always 'app_version'); `value` is a semver-ish string (e.g. "0.14.1").
 */
function ensureDbMetaTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Read the recorded app version from `__db_meta`, or null when no row exists yet
 * (a DB created before issue #726, or a genuinely fresh DB on the first boot that
 * records it). Exported for tests.
 */
export function getRecordedAppVersion(sqlite: Database.Database): string | null {
  ensureDbMetaTable(sqlite);
  const row = sqlite
    .prepare("SELECT value FROM __db_meta WHERE key = 'app_version'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Compare two semver-ish strings ("MAJOR.MINOR.PATCH", optional pre-release).
 * Returns a negative number when `a` is older than `b`, zero when equal, positive
 * when `a` is newer. Only the leading numeric triple is compared — a pre-release
 * suffix on either side is ignored (the project does not gate on pre-release
 * ordering, and treating e.g. "0.14.1-rc.1" as equal to "0.14.1" is the safe
 * direction for a downgrade guard). Non-parseable components compare as 0, so a
 * malformed stored value can never be misread as "newer than" the running binary.
 * Exported so the test can exercise the ordering directly.
 */
export function compareAppVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('-')[0].split('.');
    const n = (s: string | undefined): number => {
      const m = /^\d+/.exec((s ?? '').trim());
      return m ? Number(m[0]) : 0;
    };
    return [n(parts[0]), n(parts[1]), n(parts[2])];
  };
  const [ax, ay, az] = parse(a);
  const [bx, by, bz] = parse(b);
  if (ax !== bx) return ax - bx;
  if (ay !== by) return ay - by;
  return az - bz;
}

/**
 * Issue #726: refuse to boot when the database was last migrated by a NEWER app
 * version than this running binary. Migrations only ever move the schema forward,
 * so an older binary running against a newer-shaped schema would silently read/
 * write columns and tables it does not understand — corrupting data or crashing
 * deep in a service. Throwing here (before BOOTSTRAP_SQL / migrations / any
 * request handling) keeps the container from joining the load balancer: the
 * operator's only recourse is to restore the pre-upgrade DB snapshot or boot a
 * binary >= the recorded version, which the error message spells out. A null
 * recorded version (pre-#726 DB or genuinely first boot) is treated as compatible.
 */
function assertDbVersionCompatible(sqlite: Database.Database): void {
  const recorded = getRecordedAppVersion(sqlite);
  if (recorded === null) return;
  if (compareAppVersions(recorded, APP_VERSION) > 0) {
    throw new Error(
      `Database was last migrated by Campfire v${recorded}, which is NEWER than this ` +
        `running binary (v${APP_VERSION}). Migrations only ever move the schema forward, ` +
        `so an older binary running against a newer schema is unsupported — it would ` +
        `silently corrupt data. Either boot Campfire >= v${recorded}, or restore the ` +
        `pre-upgrade database snapshot (see GET /api/v1/backup / docs/administration/operations).`,
    );
  }
}

/**
 * Record THIS binary's app version as the one that last migrated the database
 * (issue #726). Called only after migrations have run successfully so the recorded
 * version always reflects a schema the binary actually understands — a migration
 * that throws leaves the previous (older) recorded version intact.
 */
function recordAppVersion(sqlite: Database.Database): void {
  ensureDbMetaTable(sqlite);
  sqlite
    .prepare(
      "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(APP_VERSION, new Date().toISOString());
}

/**
 * Apply every not-yet-recorded migration in order, recording each in
 * `__migrations` as it succeeds. Runs BEFORE BOOTSTRAP_SQL (some migrations, e.g.
 * the users 12-step rebuild, must reshape an existing table before the CREATE
 * TABLE IF NOT EXISTS statements would otherwise leave it in the old shape). Must
 * be called with `foreign_keys` OFF (the default at open time) so a table rebuild
 * is never blocked by a constraint mid-flight — openDatabase turns enforcement on
 * only afterwards. A fresh DB records all migrations as applied even though each
 * is a no-op (the tables don't exist yet), which is correct: the bootstrap schema
 * already includes everything the migrations would add.
 */
/** The ordered migration names recorded in `__migrations` (exported for tests). */
export const MIGRATION_NAMES: ReadonlyArray<string> = MIGRATIONS.map((m) => m.name);

function runMigrations(sqlite: Database.Database): void {
  ensureMigrationsTable(sqlite);
  const applied = new Set(
    (sqlite.prepare('SELECT name FROM __migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const record = sqlite.prepare('INSERT OR IGNORE INTO __migrations (name, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    migration.run(sqlite);
    record.run(migration.name, new Date().toISOString());
  }
}

/** Absolute path to the SQLite DB file for a given data dir. */
export function dbFilePath(dataDir: string): string {
  return path.join(dataDir, 'campfire.db');
}

/** Resolve DATA_DIR the same way the app does (env override, else repo-local data/). */
export function resolveDataDir(): string {
  return process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', 'data');
}

/**
 * Open (creating + migrating if needed) the SQLite DB under `dataDir` and wrap
 * it in a drizzle instance. Returns the raw handle too so callers that need to
 * VACUUM INTO / close it (the backup/restore module) can reach it. Extracted
 * from the old `createDb()` so DbHolder can call it again on a live restore.
 */
export function openDatabase(dataDir: string): {
  sqlite: Database.Database;
  orm: DrizzleDb;
  ftsAvailable: boolean;
  campaignSearchFtsAvailable: boolean;
} {
  fs.mkdirSync(dataDir, { recursive: true });

  // Issue #721 boot guard: the mount must look correct BEFORE SQLite opens (and
  // auto-creates) campfire.db. assertDataMount is the single arbiter of "fresh
  // install vs broken mount": it initializes the install sentinel on first run,
  // trusts an existing sentinel, and refuses to boot when a foreign DB appears
  // without its sentinel (the missing/wrong-mount failure mode). Runs after the
  // dir mkdir so a missing DATA_DIR itself doesn't trip the guard — the dir is
  // the thing the operator mounts, the sentinel is what we write into it.
  assertDataMount(dataDir, dbFilePath(dataDir));

  const sqlite = new Database(dbFilePath(dataDir));
  sqlite.pragma('journal_mode = WAL');

  // Issue #726: BEFORE migrating, refuse to boot if the DB was last migrated by a
  // newer binary. The guard runs before BOOTSTRAP_SQL / runMigrations so a downgraded
  // binary never touches a newer-shaped schema even with an idempotent ADD COLUMN.
  assertDbVersionCompatible(sqlite);

  // Foreign-key enforcement is OFF here (SQLite's default at open) so the ordered
  // migrations below — some of which rebuild a table via the 12-step DROP/CREATE
  // pattern — are never blocked by a constraint mid-rebuild. It is turned ON at the
  // end, after the schema is settled, for all of the app's runtime writes.
  runMigrations(sqlite);

  // Issue #726: AFTER migrations succeed, record THIS binary as the one that last
  // migrated the DB. Placed here (not inside runMigrations) so a migration that
  // throws never advances the recorded version — the next boot still sees the older
  // recorded version, and the guard stays meaningful for a subsequent older binary.
  recordAppVersion(sqlite);

  sqlite.exec(BOOTSTRAP_SQL);
  // BOOTSTRAP_SQL runs AFTER the migrations so a just-rebuilt table (e.g. users) is
  // recreated in its modern shape via CREATE TABLE IF NOT EXISTS only when missing,
  // and keeps idx_users_oidc_sub in sync. This is also how index-only migrations
  // reach existing DBs: e.g. #74's idx_audit_campaign_id_desc / idx_audit_created_at
  // are picked up on the next boot with no bespoke ALTER migration needed.
  const ftsAvailable = setupRuleEntriesFts(sqlite);
  const campaignSearchFtsAvailable = setupCampaignSearchFts(sqlite);

  // Enable foreign-key enforcement for every subsequent write on this connection
  // (issue #69). Fresh DBs created from BOOTSTRAP_SQL now carry the declared
  // ON DELETE CASCADE / SET NULL constraints; databases created before this change
  // keep no FK constraints (SQLite can't ALTER-ADD one, and BOOTSTRAP_SQL's
  // IF NOT EXISTS never rewrites an existing table) and continue to rely on the
  // service-layer manual cascades — enabling the pragma is harmless for them since
  // there are no constraints to enforce. Per-connection, so DbHolder.reopen /
  // withDatabaseClosed re-applies it through this same openDatabase path.
  sqlite.pragma('foreign_keys = ON');

  // Startup diagnostic (issue #235): surface any pre-existing dangling references. Read-only.
  logForeignKeyViolations(sqlite);

  return { sqlite, orm: drizzle(sqlite, { schema }), ftsAvailable, campaignSearchFtsAvailable };
}

/**
 * Owns the live SQLite handle behind a single stable drizzle *proxy*. Every
 * `@Inject(DB)` consumer receives `holder.proxy`, whose every access is
 * forwarded to the current underlying drizzle instance — so `reopen()` can
 * swap the file out from under a whole-server restore (BackupService) and all
 * existing services transparently pick up the new database with no re-injection.
 */
@Injectable()
export class DbHolder implements OnApplicationShutdown {
  private readonly logger = new Logger(DbHolder.name);
  private sqlite: Database.Database;
  private orm: DrizzleDb;
  private closed = false;
  readonly ftsAvailable: boolean;
  readonly campaignSearchFtsAvailable: boolean;

  /** Stable object handed to every DB consumer; forwards to the current `orm`. */
  readonly proxy: DrizzleDb;

  constructor() {
    const opened = openDatabase(resolveDataDir());
    this.sqlite = opened.sqlite;
    this.orm = opened.orm;
    this.ftsAvailable = opened.ftsAvailable;
    this.campaignSearchFtsAvailable = opened.campaignSearchFtsAvailable;

    this.proxy = new Proxy({} as DrizzleDb, {
      get: (_target, prop) => {
        const current = this.orm as unknown as Record<string | symbol, unknown>;
        const value = current[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(current) : value;
      },
    });
  }

  /** The raw better-sqlite3 handle (for VACUUM INTO backups). */
  get raw(): Database.Database {
    return this.sqlite;
  }

  /**
   * The restore trap (issue #164): the DB is opened in WAL mode, so freshly
   * written data lives in the `-wal` sidecar until a checkpoint folds it into
   * the main `campfire.db` file. WAL's auto-checkpoint only fires once the log
   * crosses ~1000 pages (~4MB), so on a small install the main file can stay a
   * near-empty stub indefinitely — and because the handle was never closed, the
   * checkpoint SQLite normally runs when the *last* connection closes never
   * happened either. Result: `cp campfire.db` (without the `-wal`) produced a
   * blank "no such table: users" database.
   *
   * NestJS calls this on SIGTERM/SIGINT (docker stop) because main.ts enables
   * shutdown hooks. We force a TRUNCATE checkpoint — which both folds the WAL
   * into the main file AND resets the `-wal` back to zero bytes — then close the
   * handle. After a graceful shutdown, a plain copy of `campfire.db` alone is a
   * complete, restorable database. (The `.backup`/`VACUUM INTO` path in
   * BackupService is WAL-safe even while running and remains the recommended
   * backup mechanism.)
   */
  onApplicationShutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.sqlite.open) {
        this.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      }
    } catch (err) {
      // Best-effort: a failed checkpoint must not block shutdown. close() below
      // still triggers SQLite's own last-connection checkpoint as a fallback.
      this.logger.warn(`WAL checkpoint on shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (this.sqlite.open) {
        this.sqlite.close();
      }
    } catch (err) {
      this.logger.warn(`Closing SQLite handle on shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Close the live SQLite handle, run `mutate` (which may replace the DB file
   * on disk — used by a whole-server restore), then re-open. The re-open runs
   * even if `mutate` throws, so the app is never left without a database. All
   * `@Inject(DB)` consumers keep their proxy and transparently see the new one.
   */
  withDatabaseClosed(mutate: (dataDir: string) => void): void {
    const dataDir = resolveDataDir();
    try {
      this.sqlite.close();
    } catch {
      // best-effort — proceed to swap the file regardless.
    }
    try {
      mutate(dataDir);
    } finally {
      const opened = openDatabase(dataDir);
      this.sqlite = opened.sqlite;
      this.orm = opened.orm;
    }
  }
}

@Global()
@Module({
  providers: [
    { provide: DB_HOLDER, useClass: DbHolder },
    { provide: DB, useFactory: (holder: DbHolder) => holder.proxy, inject: [DB_HOLDER] },
    { provide: RULE_ENTRIES_FTS_AVAILABLE, useFactory: (holder: DbHolder) => holder.ftsAvailable, inject: [DB_HOLDER] },
    { provide: CAMPAIGN_SEARCH_FTS_AVAILABLE, useFactory: (holder: DbHolder) => holder.campaignSearchFtsAvailable, inject: [DB_HOLDER] },
  ],
  exports: [DB, DB_HOLDER, RULE_ENTRIES_FTS_AVAILABLE, CAMPAIGN_SEARCH_FTS_AVAILABLE],
})
export class DbModule {}
