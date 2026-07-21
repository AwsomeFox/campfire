import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { dbFilePath } from '../../src/db/db.module';

/**
 * Shared fixtures for the real-SQLite integration layer (issue #80).
 *
 * These specs exercise the *storage* concerns the HTTP e2e suites take for
 * granted: the hand-rolled ADD-COLUMN migrations in db.module (do they run on a
 * genuinely old-shaped DB, and are they idempotent?), the manual multi-table
 * cascade deletes (do any orphan rows survive a campaign delete? — issue #96),
 * and the atomic write paths under concurrency (proposal CAS #85, HP #86).
 *
 * All of it runs against a real better-sqlite3 file, never a mock — the point of
 * the layer is to catch things that only break against actual SQLite semantics.
 */

/** dev-auth header identities (DEV_AUTH=1 path — see SessionAuthGuard). */
export const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'ci-dm' };
export const player = { 'x-dev-role': 'player', 'x-dev-user': 'ci-player' };

/** A fresh, empty temp data dir (caller is responsible for cleanup). */
export function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-integration-'));
}

/** Open the campfire.db under `dataDir` as a raw better-sqlite3 handle for inspection. */
export function openRawDb(dataDir: string): Database.Database {
  return new Database(dbFilePath(dataDir));
}

/** Column names currently present on a table (via PRAGMA table_info). */
export function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** COUNT(*) of a table, optionally filtered by a WHERE clause. */
export function countRows(sqlite: Database.Database, table: string, where = ''): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
  return (sqlite.prepare(sql).get() as { n: number }).n;
}

/**
 * Write a genuinely *old-shaped* campfire.db to `dataDir`: every table is
 * created WITHOUT the columns the db.module migrations later add, and seeded
 * with one row so we can prove the data survives the upgrade. The oldest
 * `users` shape (password_hash NOT NULL, no oidc_sub) is what triggers the
 * 12-step table rebuild in migrateUsersTableForOidc; every other table exercises
 * a plain ADD COLUMN path.
 *
 * Mirrors the pre-migration DDL that BOOTSTRAP_SQL has since grown past. Kept
 * deliberately literal (raw SQL, not the drizzle schema) so it can't silently
 * drift back into "new shape" and stop testing the upgrade.
 */
export function writeOldSchemaDb(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(dbFilePath(dataDir));
  const now = '2024-01-01T00:00:00.000Z';
  sqlite.exec(`
    -- users: password_hash NOT NULL, no oidc_sub / accent_color / text_size.
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      server_role TEXT NOT NULL DEFAULT 'user',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- campaigns: no rule_system / map_attachment_id / ics_token.
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      current_location_id INTEGER,
      danger_level TEXT NOT NULL DEFAULT 'low',
      session_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- characters: no xp / sheet-depth columns / dm_secret.
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      species TEXT NOT NULL DEFAULT '',
      class_name TEXT NOT NULL DEFAULT '',
      level INTEGER NOT NULL DEFAULT 1,
      background TEXT NOT NULL DEFAULT '',
      stats TEXT NOT NULL DEFAULT '{}',
      ac INTEGER,
      hp_current INTEGER NOT NULL DEFAULT 10,
      hp_max INTEGER NOT NULL DEFAULT 10,
      conditions TEXT NOT NULL DEFAULT '[]',
      portrait_url TEXT,
      ddb_id TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- quests / npcs: no hidden.
    CREATE TABLE quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      parent_id INTEGER,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      giver_npc_id INTEGER,
      reward TEXT NOT NULL DEFAULT '',
      dm_secret TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE npcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      disposition TEXT NOT NULL DEFAULT 'neutral',
      location_id INTEGER,
      body TEXT NOT NULL DEFAULT '',
      dm_secret TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- sessions: no dm_secret.
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      played_at TEXT,
      recap TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- api_tokens: no admin_enabled.
    CREATE TABLE api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      campaign_id INTEGER,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- proposals: no snapshot.
    CREATE TABLE proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      proposer TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- encounters: no current_combatant_id.
    CREATE TABLE encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'preparing',
      round INTEGER NOT NULL DEFAULT 0,
      turn_index INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- combatants: no hp_temp / death_state / death_save_successes / death_save_failures (issue #57).
    CREATE TABLE combatants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      encounter_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      character_id INTEGER,
      name TEXT NOT NULL,
      initiative INTEGER,
      init_mod INTEGER NOT NULL DEFAULT 0,
      hp_current INTEGER NOT NULL DEFAULT 10,
      hp_max INTEGER NOT NULL DEFAULT 10,
      conditions TEXT NOT NULL DEFAULT '[]',
      rule_entry_id INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- attachments: no hidden.
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      uploader_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- rule_entries: no source (0027) and no icon_slug (0038, issue #305).
    CREATE TABLE rule_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      data_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Seed one row per table so migrations must preserve real data, not just an empty schema.
  sqlite.prepare(
    "INSERT INTO users (username, display_name, password_hash, server_role, created_at, updated_at) VALUES ('legacy-dm', 'Legacy DM', 'legacy-hash', 'admin', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO campaigns (name, description, created_at, updated_at) VALUES ('Legacy Campaign', 'from before migrations', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO characters (campaign_id, name, level, hp_current, hp_max, created_at, updated_at) VALUES (1, 'Legacy Hero', 3, 17, 24, ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO quests (campaign_id, title, created_at, updated_at) VALUES (1, 'Legacy Quest', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO npcs (campaign_id, name, created_at, updated_at) VALUES (1, 'Legacy NPC', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO sessions (campaign_id, number, recap, created_at, updated_at) VALUES (1, 1, 'the tale so far', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO api_tokens (user_id, name, scope, token_hash, token_prefix, created_at, updated_at) VALUES (1, 'legacy token', 'dm', 'legacy-token-hash', 'legacy', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO proposals (campaign_id, entity_type, action, payload, proposer, created_at, updated_at) VALUES (1, 'quest', 'update', '{}', 'legacy-player', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO encounters (campaign_id, name, created_at, updated_at) VALUES (1, 'Legacy Ambush', ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO combatants (encounter_id, kind, name, hp_current, hp_max) VALUES (1, 'monster', 'Legacy Goblin', 5, 7)",
  ).run();
  sqlite.prepare(
    "INSERT INTO attachments (campaign_id, uploader_user_id, kind, filename, mime, size, created_at, updated_at) VALUES (1, 'legacy-dm', 'image', 'map.png', 'image/png', 1234, ?, ?)",
  ).run(now, now);
  sqlite.prepare(
    "INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at) VALUES (1, 'legacy-fireball', 'Legacy Fireball', 'spell', 'a bright streak', 'boom', ?, ?)",
  ).run(now, now);

  sqlite.close();
}

/**
 * Seed a campaign packed with children across every table the campaign-delete
 * cascade touches, driving real HTTP endpoints (so the rows are shaped exactly
 * as production writes them). Returns the campaign id plus a couple of child ids
 * the caller may want. Uses the dev-auth `dm` identity on `server`.
 */
export async function seedFullCampaign(
  server: Parameters<typeof request>[0],
  name: string,
): Promise<{ campaignId: number; questId: number; encounterId: number; characterId: number }> {
  const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
  const campaignId = campaign.body.id as number;

  const character = await request(server)
    .post(`/api/v1/campaigns/${campaignId}/characters`)
    .set(dm)
    .send({ name: 'Cascade Hero', hpMax: 20, hpCurrent: 20 });
  const characterId = character.body.id as number;

  const quest = await request(server)
    .post(`/api/v1/campaigns/${campaignId}/quests`)
    .set(dm)
    .send({ title: 'Cascade Quest' });
  const questId = quest.body.id as number;
  // A quest objective — cascades off the quest id, not campaign_id directly.
  await request(server)
    .post(`/api/v1/quests/${questId}/objectives`)
    .set(dm)
    .send({ text: 'do the thing' });

  await request(server).post(`/api/v1/campaigns/${campaignId}/npcs`).set(dm).send({ name: 'Cascade NPC' });
  await request(server).post(`/api/v1/campaigns/${campaignId}/locations`).set(dm).send({ name: 'Cascade Keep' });
  await request(server).post(`/api/v1/campaigns/${campaignId}/notes`).set(dm).send({ body: 'a cascade note' });
  await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Session 1' });

  const encounter = await request(server)
    .post(`/api/v1/campaigns/${campaignId}/encounters`)
    .set(dm)
    .send({ name: 'Cascade Fight' });
  const encounterId = encounter.body.id as number;
  // A combatant — cascades off the encounter id.
  await request(server)
    .post(`/api/v1/encounters/${encounterId}/combatants`)
    .set(dm)
    .send({ kind: 'monster', name: 'Goblin', hpMax: 7, hpCurrent: 7 });

  // A pending proposal (player proposes a quest edit).
  await request(server)
    .patch(`/api/v1/quests/${questId}?proposed=true`)
    .set(player)
    .send({ title: 'Player idea' });

  return { campaignId, questId, encounterId, characterId };
}
