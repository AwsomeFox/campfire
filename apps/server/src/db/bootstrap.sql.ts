/**
 * Bootstrap DDL, executed on boot via better-sqlite3 `.exec()`.
 * Simple CREATE TABLE IF NOT EXISTS statements.
 *
 * Foreign keys (issue #69). Every CREATE TABLE below declares the referential
 * integrity for its relationships:
 *   - `ON DELETE CASCADE` for STRICT children — a row that has no meaning without
 *     its parent (quest_objectives→quests, combatants→encounters, every
 *     campaign_id→campaigns, etc.). Deleting the parent removes them automatically.
 *   - `ON DELETE SET NULL` for SOFT references — a row that survives its referent
 *     losing it (combatants.character_id→characters, campaign_members.character_id,
 *     encounters.location_id/quest_id/session_id, npcs.location_id,
 *     quests.giver_npc_id, campaigns.current_location_id, …). The column is nulled,
 *     the row stays.
 *
 * Campaign is the root of the graph: almost every table cascades from campaigns(id),
 * so a single `DELETE FROM campaigns` tears down the whole tree. Enforcement is
 * turned on per-connection via `PRAGMA foreign_keys = ON` in db.module's openDatabase.
 *
 * IMPORTANT — fresh DBs only: SQLite cannot ADD a foreign key to an existing table
 * (there is no `ALTER TABLE … ADD CONSTRAINT`, and these CREATE TABLE statements are
 * `IF NOT EXISTS`, so a table that already exists is never rewritten). Therefore FK
 * ENFORCEMENT applies to databases first created from this bootstrap. Databases that
 * predate this change keep working exactly as before via the hand-written cascades in
 * the service layer (CampaignsService.remove et al.), which delete children in
 * FK-safe (child-first) order and are a strict superset of what the constraints do.
 * See the migration notes in db.module.ts. Forward references (a table referencing one
 * created later in this script, e.g. campaigns→locations) are permitted by SQLite —
 * FK targets are only resolved at write time, not at CREATE TABLE time.
 */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  current_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  danger_level TEXT NOT NULL DEFAULT 'low',
  session_count INTEGER NOT NULL DEFAULT 0,
  rule_system TEXT NOT NULL DEFAULT '',
  map_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  ics_token TEXT,
  storage_quota_bytes INTEGER,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  background TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  stats TEXT NOT NULL DEFAULT '{}',
  ac INTEGER,
  hp_current INTEGER NOT NULL DEFAULT 10,
  hp_max INTEGER NOT NULL DEFAULT 10,
  conditions TEXT NOT NULL DEFAULT '[]',
  save_proficiencies TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '[]',
  spell_slots TEXT NOT NULL DEFAULT '{}',
  portrait_url TEXT,
  ddb_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  dm_secret TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES quests(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  giver_npc_id INTEGER REFERENCES npcs(id) ON DELETE SET NULL,
  reward TEXT NOT NULL DEFAULT '',
  dm_secret TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quest_objectives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS story_arcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_beats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  arc_id INTEGER NOT NULL REFERENCES story_arcs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beat_id INTEGER NOT NULL REFERENCES story_beats(id) ON DELETE CASCADE,
  to_beat_id INTEGER REFERENCES story_beats(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  in_world_date TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  era TEXT NOT NULL DEFAULT '',
  sort_index INTEGER NOT NULL DEFAULT 0,
  dm_secret TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_calendars (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  current_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_zero (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  lines TEXT NOT NULL DEFAULT '[]',
  veils TEXT NOT NULL DEFAULT '[]',
  safety_tools TEXT NOT NULL DEFAULT '[]',
  house_rules TEXT NOT NULL DEFAULT '',
  tone_and_expectations TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS npcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT 'neutral',
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  faction_id INTEGER REFERENCES factions(id) ON DELETE SET NULL,
  body TEXT NOT NULL DEFAULT '',
  dm_secret TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  dm_secret TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  reputation INTEGER NOT NULL DEFAULT 0,
  standing TEXT NOT NULL DEFAULT 'neutral',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unexplored',
  map_x REAL,
  map_y REAL,
  body TEXT NOT NULL DEFAULT '',
  dm_secret TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  played_at TEXT,
  recap TEXT NOT NULL DEFAULT '',
  dm_secret TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  character_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(session_id, character_id)
);

CREATE TABLE IF NOT EXISTS scheduled_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 240,
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_session_id INTEGER NOT NULL REFERENCES scheduled_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scheduled_session_id, user_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note',
  visibility TEXT NOT NULL DEFAULT 'private',
  entity_type TEXT,
  entity_id INTEGER,
  recipient_user_id TEXT,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_note TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  in_character INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Prose revision history (issue #157). NEW table, so a plain CREATE TABLE IF NOT EXISTS
-- in bootstrap reaches both fresh and existing DBs (it runs every boot) — no migrate fn
-- needed, same as encounter_events (#61). campaign_id carries ON DELETE CASCADE so a
-- DELETE FROM campaigns tears revisions down with the rest of the tree (FK enforced on
-- this newly-created table on every DB, fresh or upgraded). entity_type/entity_id is a
-- POLYMORPHIC reference across sessions/quests/npcs/locations — no single FK can span
-- four tables — so the owning service's remove() deletes its own entity's revisions
-- (mirroring the session_attendees hand-cleanup), keeping no orphan behind a single
-- entity delete. See db/schema.ts for column docs.
CREATE TABLE IF NOT EXISTS entity_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL DEFAULT '{}',
  author_user_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- audit_log deliberately carries NO foreign key on campaign_id (issue #69). Audit
-- records must OUTLIVE the entities they describe: CampaignsService.remove writes its
-- own campaign.delete row AFTER the campaign row is gone, so a REFERENCES campaigns(id)
-- constraint (any action) would reject that very insert. The column stays a loose,
-- historical reference by design; the retention sweep (issue #74) is what prunes it.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  server_role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  oidc_sub TEXT,
  accent_color TEXT,
  text_size TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  code_hash TEXT UNIQUE,
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT NOT NULL DEFAULT '',
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS campaign_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_by_user_id INTEGER,
  expires_at TEXT NOT NULL,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  write_scope TEXT NOT NULL DEFAULT 'direct',
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  admin_enabled INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- MCP OAuth (issue #37): Campfire as a minimal OAuth 2.1 authorization server so
-- /mcp can be added as a Claude connector. See db/schema.ts for column docs.
-- No foreign keys declared on the oauth_* tables (issue #69): they reference users by
-- INTEGER user_id and clients by TEXT client_id and are governed by their own
-- expiry/revocation lifecycle rather than the campaign graph — an expired or campaign-
-- scoped grant is cleaned by the OAuth service, not by a cascade. Kept FK-free to avoid
-- coupling token issuance to row-existence checks on a hot auth path.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT,
  client_name TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT,
  resource TEXT,
  role_scope TEXT NOT NULL DEFAULT 'dm',
  campaign_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT UNIQUE,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  scope TEXT,
  resource TEXT,
  role_scope TEXT NOT NULL DEFAULT 'dm',
  campaign_id INTEGER,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  installed_at TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rule_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES rule_packs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  data_json TEXT,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  snapshot TEXT,
  proposer TEXT NOT NULL,
  proposer_user_id TEXT NOT NULL DEFAULT '',
  proposer_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  uploader_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encounters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  round INTEGER NOT NULL DEFAULT 0,
  turn_index INTEGER NOT NULL DEFAULT 0,
  current_combatant_id INTEGER REFERENCES combatants(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  quest_id INTEGER REFERENCES quests(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  map_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  grid_size REAL,
  grid_scale REAL,
  grid_unit TEXT,
  grid_snap INTEGER NOT NULL DEFAULT 0,
  fog TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dice_rolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  roller_user_id TEXT NOT NULL,
  roller_name TEXT NOT NULL DEFAULT '',
  expr TEXT NOT NULL,
  rolls TEXT NOT NULL DEFAULT '[]',
  kept TEXT,
  total INTEGER NOT NULL,
  label TEXT,
  dc INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  entity_type TEXT,
  entity_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL DEFAULT 'party',
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS party_treasury (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  cp INTEGER NOT NULL DEFAULT 0,
  sp INTEGER NOT NULL DEFAULT 0,
  ep INTEGER NOT NULL DEFAULT 0,
  gp INTEGER NOT NULL DEFAULT 0,
  pp INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_dm_seats (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  token_budget INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_turn_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combatants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  initiative INTEGER,
  init_mod INTEGER NOT NULL DEFAULT 0,
  hp_current INTEGER NOT NULL DEFAULT 10,
  hp_max INTEGER NOT NULL DEFAULT 10,
  hp_temp INTEGER NOT NULL DEFAULT 0,
  death_state TEXT NOT NULL DEFAULT 'none',
  death_save_successes INTEGER NOT NULL DEFAULT 0,
  death_save_failures INTEGER NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL DEFAULT '[]',
  rule_entry_id INTEGER REFERENCES rule_entries(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  token_x REAL,
  token_y REAL,
  token_size TEXT NOT NULL DEFAULT 'medium'
);

-- Persistent per-encounter combat log (issue #61). New table, so a plain
-- CREATE TABLE IF NOT EXISTS in bootstrap (no migrate fn needed). See db/schema.ts
-- for column docs; detail deliberately omits monster exact-HP totals (only deltas)
-- so listing it to a non-DM can't leak issue #43's redaction.
CREATE TABLE IF NOT EXISTS encounter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  actor TEXT,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub);
CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id);
CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests(campaign_id);
CREATE INDEX IF NOT EXISTS idx_quest_objectives_quest ON quest_objectives(quest_id);
CREATE INDEX IF NOT EXISTS idx_story_arcs_campaign ON story_arcs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_story_beats_arc ON story_beats(arc_id);
CREATE INDEX IF NOT EXISTS idx_story_beats_campaign ON story_beats(campaign_id);
CREATE INDEX IF NOT EXISTS idx_story_branches_beat ON story_branches(beat_id);
CREATE INDEX IF NOT EXISTS idx_timeline_events_campaign ON timeline_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_npcs_campaign ON npcs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_locations_campaign ON locations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_session_attendees_session ON session_attendees(session_id);
CREATE INDEX IF NOT EXISTS idx_session_attendees_character ON session_attendees(character_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_session ON session_shares(session_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_campaign ON session_shares(campaign_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_campaign ON scheduled_sessions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_session_rsvps_schedule ON session_rsvps(scheduled_session_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_ics_token ON campaigns(ics_token);
-- #116: normal campaign listings filter deleted_at IS NULL; the trash view filters
-- IS NOT NULL. Index it so both are index scans rather than full-table filters.
CREATE INDEX IF NOT EXISTS idx_campaigns_deleted_at ON campaigns(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_campaign ON notes(campaign_id);
-- #123: comment threads are always read for one entity (campaign + type + id),
-- newest-thread-context ordering handled in SQL; this composite covers the lookup.
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(campaign_id, entity_type, entity_id);
-- #157: revisions are always listed for one entity (type + id), newest-first; this
-- composite covers the lookup. The campaign index backs the cascade/teardown scans.
CREATE INDEX IF NOT EXISTS idx_entity_revisions_entity ON entity_revisions(entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_entity_revisions_campaign ON entity_revisions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_audit_campaign ON audit_log(campaign_id);
-- #74: most-recent-first reads are always scoped by campaign (or by the null-campaign
-- server-admin bucket) and ordered by id DESC. The plain campaign_id index above can't
-- serve the ORDER BY, so large logs degrade to a filesort. This composite covers both.
CREATE INDEX IF NOT EXISTS idx_audit_campaign_id_desc ON audit_log(campaign_id, id DESC);
-- #74: retention prune deletes by created_at across all campaigns; index it so the
-- periodic sweep is a range scan rather than a full-table scan.
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user ON password_reset_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_members_campaign ON campaign_members(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_members_user ON campaign_members(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_invites_campaign ON campaign_invites(campaign_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_user ON oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_client ON oauth_auth_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_proposals_campaign ON proposals(campaign_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_rule_entries_pack ON rule_entries(pack_id);
CREATE INDEX IF NOT EXISTS idx_rule_entries_type ON rule_entries(type);
CREATE INDEX IF NOT EXISTS idx_rule_entries_slug ON rule_entries(slug);
-- One canonical row per (pack, type, slug): the importer/upload paths dedupe on this key,
-- and the unique index makes an accidental exact-duplicate insert a caught constraint error
-- rather than a silently-duplicated compendium row (issue #143). Existing DBs are de-duped
-- by migrateRuleEntriesTableForSource (runs before this) so the index can be created cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_entries_pack_type_slug ON rule_entries(pack_id, type, slug);
CREATE INDEX IF NOT EXISTS idx_attachments_campaign ON attachments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_encounters_campaign ON encounters(campaign_id);
CREATE INDEX IF NOT EXISTS idx_encounters_status ON encounters(status);
CREATE INDEX IF NOT EXISTS idx_combatants_encounter ON combatants(encounter_id);
CREATE INDEX IF NOT EXISTS idx_encounter_events_encounter ON encounter_events(encounter_id);
CREATE INDEX IF NOT EXISTS idx_dice_rolls_campaign ON dice_rolls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_campaign ON inventory_items(campaign_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_character ON inventory_items(character_id);
`;

/**
 * FTS5 virtual table + sync triggers for rule_entries, created separately
 * from BOOTSTRAP_SQL (not every SQLite build ships the fts5 extension —
 * better-sqlite3's bundled build does, but we detect at runtime in
 * db.module.ts rather than assume, and fall back to LIKE search when it's
 * unavailable). Content table is rule_entries itself (contentless=no) so we
 * don't duplicate storage; triggers keep the index in sync on write.
 */
export const RULE_ENTRIES_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS rule_entries_fts USING fts5(
  name, summary, body, content='rule_entries', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS rule_entries_ai AFTER INSERT ON rule_entries BEGIN
  INSERT INTO rule_entries_fts(rowid, name, summary, body) VALUES (new.id, new.name, new.summary, new.body);
END;

CREATE TRIGGER IF NOT EXISTS rule_entries_ad AFTER DELETE ON rule_entries BEGIN
  INSERT INTO rule_entries_fts(rule_entries_fts, rowid, name, summary, body) VALUES ('delete', old.id, old.name, old.summary, old.body);
END;

CREATE TRIGGER IF NOT EXISTS rule_entries_au AFTER UPDATE ON rule_entries BEGIN
  INSERT INTO rule_entries_fts(rule_entries_fts, rowid, name, summary, body) VALUES ('delete', old.id, old.name, old.summary, old.body);
  INSERT INTO rule_entries_fts(rowid, name, summary, body) VALUES (new.id, new.name, new.summary, new.body);
END;
`;
