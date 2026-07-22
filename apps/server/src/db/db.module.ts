import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BOOTSTRAP_SQL, RULE_ENTRIES_FTS_SQL } from './bootstrap.sql';
import * as schema from './schema';

export const DB = Symbol('DB');
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

/** Module-scoped logger for the free functions (openDatabase et al.) that run outside a Nest provider. */
const dbLog = new Logger('Database');

/**
 * The version of THIS running binary, single-sourced from apps/server/package.json (the same
 * source /healthz and /readyz report — see health.controller.ts). Recorded alongside the
 * migration log in `__db_meta` (issue #726) so a subsequently booted OLDER binary can detect
 * that the DB was last touched by a newer app version and refuse to start against a schema it
 * does not understand, rather than silently writing into it.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const APP_VERSION: string = require('../../package.json').version;

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
  for (const table of ['campaigns', 'quests', 'npcs', 'locations', 'sessions', 'notes', 'characters']) {
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
} {
  fs.mkdirSync(dataDir, { recursive: true });
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

  return { sqlite, orm: drizzle(sqlite, { schema }), ftsAvailable };
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

  /** Stable object handed to every DB consumer; forwards to the current `orm`. */
  readonly proxy: DrizzleDb;

  constructor() {
    const opened = openDatabase(resolveDataDir());
    this.sqlite = opened.sqlite;
    this.orm = opened.orm;
    this.ftsAvailable = opened.ftsAvailable;

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
  ],
  exports: [DB, DB_HOLDER, RULE_ENTRIES_FTS_AVAILABLE],
})
export class DbModule {}
