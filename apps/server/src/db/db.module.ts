import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BOOTSTRAP_SQL, RULE_ENTRIES_FTS_SQL } from './bootstrap.sql';
import * as schema from './schema';

export const DB = Symbol('DB');
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

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
  migrateUsersTableForOidc(sqlite);
  migrateCampaignsTableForRuleSystem(sqlite);
  migrateUsersTableForAccentColor(sqlite);
  migrateUsersTableForTextSize(sqlite);
  migrateCampaignsTableForMapAttachment(sqlite);
  migrateApiTokensTableForAdminEnabled(sqlite);
  migrateProposalsTableForSnapshot(sqlite);
  migrateProposalsTableForAttribution(sqlite);
  migrateCharactersTableForSheetDepth(sqlite);
  migrateCampaignsTableForIcsToken(sqlite);
  migrateCampaignsTableForStorageQuota(sqlite);
  migrateCharactersTableForXp(sqlite);
  migrateCharactersTableForStatus(sqlite);
  migrateCharactersTableForDmSecret(sqlite);
  migrateNotesTableForRecipient(sqlite);
  migrateSessionsTableForDmSecret(sqlite);
  migrateEncountersTableForCurrentCombatant(sqlite);
  migrateCombatantsTableForHpModel(sqlite);
  migrateQuestsTableForHidden(sqlite);
  migrateNpcsTableForHidden(sqlite);
  migrateAttachmentsTableForHidden(sqlite);
  migrateLocationsTableForParentId(sqlite);
  migrateRuleEntriesTableForSource(sqlite);
  migrateDiceRollsTableForKeepDrop(sqlite);
  sqlite.exec(BOOTSTRAP_SQL);
  // after the rebuild is safe and keeps idx_users_oidc_sub in sync. This is
  // also how index-only migrations reach existing DBs: e.g. #74's
  // idx_audit_campaign_id_desc / idx_audit_created_at are picked up on the
  // next boot with no bespoke ALTER migration needed.
  const ftsAvailable = setupRuleEntriesFts(sqlite);
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
