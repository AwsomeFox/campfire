/**
 * Campaign module tables (issue #585) — package identity, install/fork lineage, the
 * per-artifact BASELINE that makes update previews a real three-way compare, and the
 * pre-apply snapshots rollback restores from.
 *
 * Exported and interpolated into BOOTSTRAP_SQL below AND re-executed verbatim by
 * `migrateCampaignModules585` in db.module.ts, so the fresh-DB and upgraded-DB shapes
 * are the same text and cannot drift. All three statements are IF NOT EXISTS, so
 * running them in either order (migrations execute before BOOTSTRAP_SQL) is a no-op
 * the second time.
 *
 * Why the columns exist:
 *  - `module_id` is the stable package UUID; UNIQUE(campaign_id, module_id) is what an
 *    update is matched on. Nothing here is derived from the campaign or module NAME, so
 *    renaming either cannot sever lineage.
 *  - `manifest_json` stores the manifest exactly as installed — the identity baseline.
 *  - `baseline_json` / `baseline_hash` store the artifact content exactly as installed.
 *    Without them, "the table edited this" and "the publisher edited this" are
 *    indistinguishable and three-way merge is impossible.
 *  - `overlay_json` is the local divergence retained across an update, so BASE can
 *    advance to upstream without losing (or silently re-conflicting on) the table's edits.
 */
export const CAMPAIGN_MODULES_DDL = `
CREATE TABLE IF NOT EXISTS campaign_module_installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  authors_json TEXT NOT NULL DEFAULT '[]',
  compatibility_json TEXT NOT NULL DEFAULT '{}',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  origin_kind TEXT NOT NULL DEFAULT 'install',
  origin_source_url TEXT NOT NULL DEFAULT '',
  upstream_module_id TEXT,
  upstream_version TEXT,
  forked_at TEXT,
  detached INTEGER NOT NULL DEFAULT 0,
  detached_at TEXT,
  installed_at TEXT NOT NULL,
  installed_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, module_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_module_installs_campaign ON campaign_module_installs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_module_installs_module ON campaign_module_installs(module_id);
CREATE INDEX IF NOT EXISTS idx_campaign_module_installs_upstream ON campaign_module_installs(upstream_module_id);

CREATE TABLE IF NOT EXISTS campaign_module_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id INTEGER NOT NULL REFERENCES campaign_module_installs(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  baseline_hash TEXT NOT NULL,
  baseline_json TEXT NOT NULL DEFAULT '{}',
  overlay_json TEXT,
  installed_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(install_id, kind, artifact_key)
);
CREATE INDEX IF NOT EXISTS idx_campaign_module_artifacts_install ON campaign_module_artifacts(install_id);
CREATE INDEX IF NOT EXISTS idx_campaign_module_artifacts_entity ON campaign_module_artifacts(campaign_id, kind, entity_id);

CREATE TABLE IF NOT EXISTS campaign_module_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id INTEGER NOT NULL REFERENCES campaign_module_installs(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'update',
  from_version TEXT NOT NULL DEFAULT '',
  to_version TEXT NOT NULL DEFAULT '',
  artifact_count INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  rolled_back_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaign_module_snapshots_install ON campaign_module_snapshots(install_id, id);
`;

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
 * predate this change keep working via the hand-written cascade in the service layer
 * (CampaignsService.purge — the hard-delete path), which deletes children child-first
 * and now covers EVERY campaign-scoped table so a purge on a non-FK DB leaves zero
 * orphans (issue #235; it previously missed ~16 newer tables). On boot we also run a
 * `foreign_key_check` diagnostic (db.module.ts) that logs any pre-existing violation.
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
  dm_controls_progression INTEGER NOT NULL DEFAULT 0,
  -- Issue #413: turn-advancement controls. dm_controls_turns=1 keeps advancement DM-only
  -- (players cannot end their own turn); require_dm_turn_confirmation=1 stages a player's
  -- end-turn for DM approval instead of advancing immediately.
  dm_controls_turns INTEGER NOT NULL DEFAULT 0,
  require_dm_turn_confirmation INTEGER NOT NULL DEFAULT 0,
  public_recap_sharing_enabled INTEGER NOT NULL DEFAULT 1,
  public_invites_enabled INTEGER NOT NULL DEFAULT 1,
  narration_language TEXT NOT NULL DEFAULT 'en',
  ai_external_content_policy TEXT NOT NULL DEFAULT 'member_consent',
  session_count INTEGER NOT NULL DEFAULT 0,
  rule_system TEXT NOT NULL DEFAULT '',
  map_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  ics_token TEXT,
  ics_token_expires_at TEXT,
  storage_quota_bytes INTEGER,
  active_encounter_id INTEGER REFERENCES encounters(id) ON DELETE SET NULL,
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
  eac INTEGER,
  kac INTEGER,
  hp_current INTEGER NOT NULL DEFAULT 10,
  hp_max INTEGER NOT NULL DEFAULT 10,
  sp_current INTEGER NOT NULL DEFAULT 0,
  sp_max INTEGER NOT NULL DEFAULT 0,
  rp_current INTEGER NOT NULL DEFAULT 0,
  rp_max INTEGER NOT NULL DEFAULT 0,
  -- Issue #711: persistent echo of the combat death/temp-HP subsystem. The
  -- encounter tracker has tracked these since issue #57, but the per-fight
  -- write-back only persisted hpCurrent, so a dead PC was resurrected on
  -- sheet read and re-conscripted into the next fight. These columns carry
  -- the post-encounter reconciliation forward.
  hp_temp INTEGER NOT NULL DEFAULT 0,
  death_state TEXT NOT NULL DEFAULT 'none',
  death_save_successes INTEGER NOT NULL DEFAULT 0,
  death_save_failures INTEGER NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL DEFAULT '[]',
  -- Issue #1047: sheet-scoped ConditionInstance[] JSON; NULL means derive from the legacy
  -- conditions names. No backticks in this file: it is one big TS template literal.
  condition_instances TEXT,
  save_proficiencies TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '[]',
  spell_slots TEXT NOT NULL DEFAULT '{}',
  resources TEXT NOT NULL DEFAULT '{}',
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
  deleted_at TEXT,
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
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  quest_id INTEGER REFERENCES quests(id) ON DELETE SET NULL,
  encounter_id INTEGER REFERENCES encounters(id) ON DELETE SET NULL,
  deleted_at TEXT,
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
  deleted_at TEXT,
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
  portrait_url TEXT,
  icon_slug TEXT NOT NULL DEFAULT '',
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
  portrait_url TEXT,
  deleted_at TEXT,
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
  portrait_url TEXT,
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
  scheduled_session_id INTEGER REFERENCES scheduled_sessions(id) ON DELETE SET NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  expires_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  first_accessed_at TEXT,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  status TEXT NOT NULL DEFAULT 'scheduled',
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancellation_reason TEXT NOT NULL DEFAULT '',
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
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
  -- Moderation quarantine (issue #601): a DM withholding an abusive note/whisper
  -- pending review. Treated exactly like deleted_at by every NORMAL read, including
  -- for the author and the whisper recipient. See db/schema.ts for the full docs.
  quarantined_at TEXT,
  quarantined_by TEXT,
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
  -- Immutable in-character attribution snapshot (issue #787). character_id is a
  -- soft reference by design; the historical name/avatar survive character removal.
  character_id INTEGER,
  character_name TEXT,
  character_avatar_url TEXT,
  -- Soft delete / tombstone (issue #503). NULL = live; a timestamp tombstones the
  -- row (body redacted, replies preserved). deleted_by records the actor. See
  -- db/schema.ts for column docs. The parent_id ON DELETE CASCADE above only ever
  -- fires on a HARD row removal (campaign purge); the comment service's remove()
  -- never DELETEs a root with replies — it sets deleted_at so the FK cascade is
  -- never the thing that destroys replies.
  deleted_at TEXT,
  deleted_by TEXT,
  -- Editor provenance for the trust case (issue #783). NULL on a live row a user
  -- only ever self-edits; stamped ONLY when a non-author (a DM moderating) edits
  -- the body, so the original author is never the apparent writer of rewritten
  -- prose. See db/schema.ts for the full column docs.
  edited_at TEXT,
  edited_by TEXT,
  -- Moderation quarantine (issue #601): the body reads back as a neutral
  -- "withheld pending moderation review" placeholder for every caller while set,
  -- and the search index drops the row. Only the moderation queue writes these.
  quarantined_at TEXT,
  quarantined_by TEXT,
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
  author_source TEXT NOT NULL DEFAULT 'human',
  author_source_detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  replaced_by_user_id TEXT NOT NULL DEFAULT '',
  replaced_by_name TEXT NOT NULL DEFAULT '',
  replaced_by_source TEXT NOT NULL DEFAULT 'human',
  replaced_by_source_detail TEXT NOT NULL DEFAULT '',
  replaced_at TEXT,
  restored_from_revision_id INTEGER,
  authorship_known INTEGER NOT NULL DEFAULT 1
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
  request_id TEXT,
  created_at TEXT NOT NULL
);

-- Moderation / abuse incidents (issue #601).
--
-- Like audit_log directly above, and for a sharper reason, campaign_id carries NO
-- foreign key: abuse evidence must OUTLIVE the campaign it was gathered in. A
-- REFERENCES campaigns(id) ON DELETE CASCADE here would make "purge the campaign"
-- a one-click way for a DM to destroy every report filed against them — the exact
-- failure #601 exists to close, and often the only surviving copy of content the
-- subject has already edited away. Retention is therefore TIME-based (expires_at,
-- redaction on expiry) rather than lifetime-based, so orphaned rows still stop
-- holding prose on schedule. See db/schema.ts for the full reasoning and column docs.
CREATE TABLE IF NOT EXISTS moderation_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'server_capture',
  author_user_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  recipient_user_id TEXT,
  anchor_entity_type TEXT,
  anchor_entity_id INTEGER,
  revision_at TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  -- sha256 over every field EXCEPT content. Redaction overwrites content, so
  -- content_hash cannot match afterwards; this digest still can, which is what stops
  -- redacted_at from being a switch that disables tamper detection for the row.
  metadata_hash TEXT NOT NULL DEFAULT '',
  redacted_at TEXT,
  redacted_by TEXT,
  redaction_reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  captured_at TEXT NOT NULL
);
-- The pre-mutation capture path asks "is there already a snapshot for this target?"
-- on every moderated edit/delete, and the expiry sweep scans by expires_at.
CREATE INDEX IF NOT EXISTS idx_moderation_evidence_target
  ON moderation_evidence(campaign_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_moderation_evidence_expiry ON moderation_evidence(expires_at);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  reporter_user_id TEXT NOT NULL,
  reporter_name TEXT NOT NULL DEFAULT '',
  subject_user_id TEXT NOT NULL DEFAULT '',
  subject_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  evidence_id INTEGER NOT NULL REFERENCES moderation_evidence(id),
  quarantined INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  escalation_reason TEXT NOT NULL DEFAULT '',
  acknowledged_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The DM queue pages by (campaign, status); the mutation hooks ask "is this target
-- under an unresolved report?" before every edit/delete.
CREATE INDEX IF NOT EXISTS idx_moderation_reports_queue ON moderation_reports(campaign_id, status, id);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_target
  ON moderation_reports(campaign_id, target_type, target_id, status);

CREATE TABLE IF NOT EXISTS moderation_mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  lifted_at TEXT,
  lifted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_moderation_mutes_active ON moderation_mutes(campaign_id, user_id, lifted_at);

-- Issue #597: personal, member-owned safety controls (block / mute_sender /
-- mute_thread). Separate from moderation_mutes above: that table is a DM SANCTION
-- and is DM-visible, this one belongs to the protected member and is never disclosed
-- to its subject. campaign_id NULL = account-wide (every block is account-wide).
CREATE TABLE IF NOT EXISTS member_safety_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER,
  kind TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  target_user_id TEXT,
  thread_entity_type TEXT,
  thread_entity_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  lifted_at TEXT
);
-- Every enforcement read is "what are OWNER's live controls" (notification fan-out,
-- note read filters); the second index answers the reverse question the block-evasion
-- check asks: "does anyone already block this identity".
CREATE INDEX IF NOT EXISTS idx_member_safety_controls_owner
  ON member_safety_controls(owner_user_id, lifted_at);
CREATE INDEX IF NOT EXISTS idx_member_safety_controls_target
  ON member_safety_controls(target_user_id, lifted_at);

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
  time_format TEXT NOT NULL DEFAULT 'system',
  dice_theme TEXT NOT NULL DEFAULT 'nocturne',
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

-- Single-row install-identity table (issue #723): the per-install UUID
-- (stable across backup/restore — it lives INSIDE the restored DB) and a
-- monotonic data_generation the server bumps on every restore. Surfaced on
-- /me (Me.instance) so the PWA namespaces its SW runtime cache by
-- instance_id:data_generation and a restore invalidates stale bytes.
-- The row is seeded lazily by ServerMetaService; this DDL just guarantees the
-- table exists. See db/schema.ts serverMeta + modules/server-meta.
CREATE TABLE IF NOT EXISTS server_meta (
  key TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  data_generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  ai_external_use_consent INTEGER NOT NULL DEFAULT 0,
  is_primary_owner INTEGER NOT NULL DEFAULT 0,
  -- Issue #597: explicit interactive-guest capability. 0 = a viewer seat is genuinely
  -- read-only (no comments / shared notes / whispers / DM-inbox posts).
  interactive_guest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, user_id)
);

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

-- Issue #549 — per-user, per-campaign catch-up cursor (independent of auth sessions).
CREATE TABLE IF NOT EXISTS campaign_catch_up_cursors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  last_caught_up_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, campaign_id)
);

-- Migration repair history for #849. No FKs by design: rows describe missing
-- references and must remain readable to a server admin without campaign access.
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

-- Issue #867: purge evidence that outlives the campaign hard-cascade. No FKs —
-- the campaigns row is deleted by purge itself. Name is stored as sha256 only.
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
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  scope TEXT,
  resource TEXT,
  role_scope TEXT NOT NULL DEFAULT 'dm',
  campaign_id INTEGER,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT,
  refresh_consumed_at TEXT,
  revoked_at TEXT,
  family_revoked_at TEXT,
  created_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_hash TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  actor_id TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT,
  errors TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at ON import_jobs(created_at);

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
  license TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  icon_slug TEXT NOT NULL DEFAULT '',
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
  base_updated_at TEXT,
  base_snapshot_hash TEXT,
  proposer TEXT NOT NULL,
  proposer_user_id TEXT NOT NULL DEFAULT '',
  proposer_token TEXT,
  generation_provenance TEXT,
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
  state TEXT NOT NULL DEFAULT 'committed' CHECK (state IN ('reserved', 'committed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Durable responsive derivatives for image attachments (issue #604). One row per
-- (attachment, ladder rung); the bytes live next to the original at
-- <campaign>/<id>.<variant>.png. Rows exist so a derivative is generated ONCE,
-- off the request path, and survives a restart: a 'pending' row is the work item
-- the background drain picks up, 'ready' is servable, 'failed' is retryable by the
-- DM, and 'skipped' records "the source is already smaller than this rung" so we
-- never regenerate a decision we already made. ON DELETE CASCADE keeps the ladder
-- from outliving its attachment; the on-disk files are queued through
-- fs_deletion_queue like any other upload artifact.
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

-- Filesystem cleanup retry queue (issue #727). Rows describe upload paths whose DB
-- metadata was removed but bytes could not be verified erased. No FKs so entries
-- survive campaign purge.
CREATE TABLE IF NOT EXISTS fs_deletion_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  campaign_id INTEGER,
  entity_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encounters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  round INTEGER NOT NULL DEFAULT 0,
  escalation_die INTEGER NOT NULL DEFAULT 0,
  escalation_die_held INTEGER NOT NULL DEFAULT 0,
  escalation_die_override INTEGER,
  escalation_die_history TEXT,
  turn_index INTEGER NOT NULL DEFAULT 0,
  current_combatant_id INTEGER REFERENCES combatants(id) ON DELETE SET NULL,
  turn_phase TEXT NOT NULL DEFAULT 'combatant',
  lair_resume_combatant_id INTEGER REFERENCES combatants(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  quest_id INTEGER REFERENCES quests(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  map_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  grid_size REAL,
  grid_scale REAL,
  grid_unit TEXT,
  grid_snap INTEGER NOT NULL DEFAULT 0,
  fog TEXT,
  grid_type TEXT NOT NULL DEFAULT 'square',
  hex_orientation TEXT NOT NULL DEFAULT 'pointy',
  aoe TEXT,
  grid_offset_x REAL NOT NULL DEFAULT 0,
  grid_offset_y REAL NOT NULL DEFAULT 0,
  grid_cell_height REAL,
  grid_rotation REAL NOT NULL DEFAULT 0,
  grid_opacity REAL NOT NULL DEFAULT 0.35,
  hidden INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT,
  aftermath_dismissed_at TEXT,
  deleted_at TEXT,
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
  -- Issue #673: honest provenance for paper-table / physical rolls.
  source TEXT NOT NULL DEFAULT 'rolled',
  actor TEXT,
  natural20 INTEGER,
  -- Per-term breakdown for compound expressions (issue #536), JSON text — null for a
  -- classic single-term roll (no breakdown). Mirrors the kept column's nullable-JSON shape.
  terms TEXT,
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
  comment_id INTEGER,
  data TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  -- Issue #597: the actor's note-identity id, so a recipient's block can filter bell
  -- items that already exist. actor_name alone is not an identity.
  actor_user_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);

-- Issue #789: per-user, per-campaign, per-category notification delivery mode.
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

-- Issue #789: per-user, per-campaign quiet-hours window (local minutes in timezone).
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

-- Issue #789: deferred notifications (digest mode or quiet-hours hold), drained
-- by NotificationsService.flushDigests() into real notifications on the cadence.
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
  -- Issue #597: carried through the deferral so a flushed row keeps its actor identity.
  actor_user_id TEXT,
  reason TEXT NOT NULL DEFAULT 'digest',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_digest_queue_campaign
  ON notification_digest_queue(campaign_id, user_id);

-- Issue #789: dedup ledger for session reminders / unanswered-RSVP nudges.
CREATE TABLE IF NOT EXISTS notification_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_session_id INTEGER NOT NULL REFERENCES scheduled_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_reminders_session_user_kind
  ON notification_reminders(scheduled_session_id, user_id, kind);

-- Issue #415: DM-initiated check requests (one row per request × target character).
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

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL DEFAULT 'party',
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  icon_slug TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

-- Issue #782: per-action idempotency for inventory quantity deltas / CAS sets.
-- Pruned by created_at TTL on write; idx_inventory_qty_idempotency_created keeps that cheap.
CREATE TABLE IF NOT EXISTS inventory_qty_idempotency (
  key TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
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
  mode TEXT NOT NULL DEFAULT 'off',
  enabled INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  token_budget INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  tokens_reserved INTEGER NOT NULL DEFAULT 0,
  tokens_refunded INTEGER NOT NULL DEFAULT 0,
  tokens_unknown INTEGER NOT NULL DEFAULT 0,
  tokens_overage INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_turn_at TEXT,
  proactive_settings TEXT DEFAULT '{}',
  style_presets TEXT DEFAULT '{}',
  action_queue_depth INTEGER DEFAULT 8,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Issue #559: durable AI Driver control state. The driver stores live recovery
-- controls separately from seat configuration so pause/takeover/vote/stuck
-- state and replay input survive a server restart.
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
  -- The recovery shape most recently ANNOUNCED to the table. A seat sitting in a steady
  -- state (paused / human_control / stuck / open vote) is announced once, not re-announced
  -- on every subsequent restart.
  announced_recovery TEXT,
  -- Issue #1042. These two are persisted so they can be REVOKED LOUDLY, not so they can be
  -- resurrected. Both are grants of authority scoped to a room the server can no longer verify
  -- after a restart: secret_read_approvals lets the AI seat read ONE named hidden entity under
  -- the DM principal (#557), and pending_tool_confirmations holds irreversible live-play tool
  -- calls awaiting a DM's explicit approval (#474). Hydration reads them, audits each one as
  -- revoked/discarded, tells the table, and then CLEARS them -- it never puts them back on the
  -- session. Before this they lived only in process memory, so a restart dropped them with no
  -- audit row and no signal, which is the silence issue #1042 is actually about: you cannot
  -- audit a revocation you have no record of.
  secret_read_approvals TEXT,
  pending_tool_confirmations TEXT,
  -- Issue #1051: collaborative handoff is on (the AI narrates, a DM decides mechanics). Its own
  -- column rather than a ladder-state value, because the state column is one slot that a pause,
  -- a takeover, or a stuck seat legitimately takes over -- and a mode that vanished when a DM
  -- paused for five minutes would silently restore full autonomy on resume.
  collaborative INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Issue #1060: per-turn AI usage history for the DM's usage sparkline and audit.
-- One row per metered turn (driver step, co-DM draft, scribe run). Cascades on
-- campaign delete so purge cleans it up automatically.
CREATE TABLE IF NOT EXISTS ai_dm_usage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tokens_used INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_dm_usage_history_campaign_created
  ON ai_dm_usage_history (campaign_id, created_at DESC, id DESC);

-- Issue #572: the AUTHORITATIVE multi-player AI-DM table transcript. Before this the
-- transcript was client-local (assembled in the browser from the SSE stream plus a local
-- echo of that one client's own submissions, cached in localStorage) — so a player who
-- joined late, reloaded, or reconnected saw a different transcript from everyone else,
-- and nobody but the sender ever saw the player action an AI answer was responding to.
--
-- ORDERING. seq is a PER-CAMPAIGN monotonic counter assigned server-side inside the
-- same synchronous better-sqlite3 transaction as the insert (see AiDmTranscriptService).
-- It is the ordering key, the pagination cursor, and the reconnect watermark. It is
-- deliberately NOT created_at (wall clock has no total order under concurrency) and
-- deliberately NOT the global autoincrement id (which interleaves across campaigns, so
-- a per-campaign cursor built on it would leak server-wide write volume). UNIQUE
-- (campaign_id, seq) makes a duplicate assignment a hard error rather than silent
-- transcript corruption.
--
-- event_id is the stable, client-visible identity (a server-minted uuid) used for
-- idempotent client-side merge when the same event arrives twice (live SSE plus a page
-- fetch after reconnect).
--
-- client_ref is the sender's optimistic-echo correlation token: the composer mints it,
-- POSTs it with the action, and the server echoes it back on the persisted event so the
-- sending client REPLACES its local optimistic entry instead of rendering the action
-- twice. A token, not content equality — two players typing the same words in the same
-- second must still produce two distinct lines.
--
-- turn_id groups the narration/tool/turn-end rows of ONE driver turn, so a client that
-- rebuilds the transcript from a REST page assembles the same DM bubble the live stream
-- produced.
--
-- visibility is row-level role redaction ('all' | 'dm'), enforced server-side at BOTH
-- the REST read and the SSE broadcast boundary. FIELD-level redaction (e.g. a hidden
-- encounter's id inside a tool payload) reuses the existing projectAiDmToolEventForRole
-- mechanism rather than inventing a second one.
--
-- Deliberately NOT stored: narration.delta. Persisting every streamed token chunk would
-- multiply this table ~100x per turn for zero added information — narration.message is the
-- aggregated authoritative text of each step and is what the transcript renders.
--
-- RETENTION: bounded to AI_DM_TRANSCRIPT_RETENTION_MAX_EVENTS rows per campaign, pruned
-- in the same transaction as each insert; cascades on campaign delete; DM-purgeable via
-- DELETE /campaigns/:id/ai-dm/transcript.
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
-- The index that matters: every read is "this campaign, ordered by seq" — page back for
-- late join, page forward from a seq for reconnect gap-fill — and the retention prune and
-- the next-seq probe are the same keyset scan. UNIQUE also guards the counter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_dm_transcript_events_campaign_seq
  ON ai_dm_transcript_events (campaign_id, seq);
-- Stable event ids are unique per campaign so a client can merge by id with no tiebreak.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_dm_transcript_events_event_id
  ON ai_dm_transcript_events (campaign_id, event_id);

-- AI provider config: encrypted API-key + provider storage (issue #310). Two
-- scopes -- 'server' (one row, the admin-managed default) and 'campaign' (a
-- per-campaign override, DM-managed, cascading on campaign delete). The API key
-- is stored ONLY as encrypted_api_key (an aes-256-gcm ciphertext -- see
-- common/crypto.ts encryptSecret); the plaintext key is NEVER stored, returned,
-- logged, or exported. Reads expose only key_last4. The partial unique indexes
-- pin exactly one server row and at most one row per campaign.
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

-- AI scribe (issue #316): per-campaign trigger config + a log of runs. The scribe
-- drafts a session recap from the campaign's own material using the configured
-- provider, always as a PROPOSAL (nothing auto-publishes to canon). Config toggles
-- are opt-in; jobs record source_hash for idempotent, non-duplicating re-runs.
CREATE TABLE IF NOT EXISTS ai_scribe_configs (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  post_session INTEGER NOT NULL DEFAULT 0,
  cron INTEGER NOT NULL DEFAULT 0,
  budget_per_run INTEGER NOT NULL DEFAULT 2000,
  source_cursor_at TEXT,
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
  scheduled_session_id INTEGER,
  source_stats TEXT,
  generation_provenance TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_scribe_jobs_campaign ON ai_scribe_jobs(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_scribe_jobs_session_trigger ON ai_scribe_jobs(campaign_id, scheduled_session_id, trigger);

CREATE TABLE IF NOT EXISTS combatants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  npc_id INTEGER REFERENCES npcs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  initiative INTEGER,
  init_mod INTEGER NOT NULL DEFAULT 0,
  initiative_breakdown TEXT,
  initiative_group TEXT,
  hp_current INTEGER NOT NULL DEFAULT 10,
  hp_max INTEGER NOT NULL DEFAULT 10,
  sp_current INTEGER NOT NULL DEFAULT 0,
  sp_max INTEGER NOT NULL DEFAULT 0,
  rp_current INTEGER NOT NULL DEFAULT 0,
  rp_max INTEGER NOT NULL DEFAULT 0,
  eac INTEGER,
  kac INTEGER,
  hp_temp INTEGER NOT NULL DEFAULT 0,
  death_state TEXT NOT NULL DEFAULT 'none',
  death_save_successes INTEGER NOT NULL DEFAULT 0,
  death_save_failures INTEGER NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL DEFAULT '[]',
  rule_entry_id INTEGER REFERENCES rule_entries(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  token_x REAL,
  token_y REAL,
  token_size TEXT NOT NULL DEFAULT 'medium',
  -- Issue #466: CAS token for sheet↔combatant HP sync (character.updatedAt at last sync).
  sheet_synced_updated_at TEXT,
  -- Issue #413: current-turn workspace state (per-turn action economy usage, movement,
  -- concentration, delay/ready) as a JSON CombatantTurnState blob, and structured active
  -- effects with duration/save timing as a JSON ActiveEffect[] blob. Null = defaults.
  turn_state TEXT,
  active_effects TEXT,
  condition_instances TEXT,
  -- Issue #425: inline homebrew statblock JSON for manual monsters.
  statblock_json TEXT
);

-- Campaign-scoped homebrew monster library (issue #425).
CREATE TABLE IF NOT EXISTS campaign_library_monsters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  statblock_json TEXT NOT NULL,
  source_rule_entry_id INTEGER REFERENCES rule_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_library_monsters_campaign ON campaign_library_monsters(campaign_id);

-- Persistent per-encounter combat log (issue #61). New table, so a plain
-- CREATE TABLE IF NOT EXISTS in bootstrap (no migrate fn needed). See db/schema.ts
-- for column docs; detail deliberately omits monster exact-HP totals (only deltas)
-- so listing it to a non-DM can't leak issue #43's redaction. actor_id/target_id
-- (issue #869) let listing re-project names from current hidden-NPC visibility.
CREATE TABLE IF NOT EXISTS encounter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  actor TEXT,
  target TEXT,
  actor_id INTEGER,
  target_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  chain_id TEXT,
  parent_event_id INTEGER,
  phase TEXT,
  performed_by_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

-- Issue #580: per-intent idempotency for NON-idempotent encounter mutations (HP deltas,
-- turn advancement). One row per (actor, operation, key); the row is INSERTed inside the
-- SAME synchronous transaction as the effect, so there is no window in which a crash can
-- leave a phantom block (key recorded, effect missing) or a double-apply (effect landed,
-- key missing).
--
-- response_json stores the ORIGINAL response body: a client that retried did so precisely
-- because it does not know the outcome, so a bare 200/409 tells it nothing — it needs the
-- committed HP / turn pointer to reconcile. response_role scopes that cached body to the
-- role it was rendered for (encounter reads are role-redacted); a replay for a different
-- role re-derives fresh instead of leaking a DM-shaped body to a player.
--
-- encounter_id/campaign_id are stored (not keyed on) so a key minted for one encounter or
-- campaign cannot be replayed against another — that is a 409 IDEMPOTENCY_KEY_REUSE, not a
-- silent cross-scope replay. Pruned by created_at TTL on write.
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

-- Issue #577: the AI driver's factual claims and whether the server could verify them.
--
-- One row per claim the driver made in a turn (rules rulings and assertions about existing
-- canon; purely creative narration needs no source and is recorded only when the model itself
-- declares it as invention). The status column is the SERVER's verdict, never the model's self-report:
-- a citation counts as supported only when the referenced id was actually returned by an
-- authorized, campaign-scoped read during that same turn. Unsupported claims are kept and
-- published marked unverified rather than deleted — the table has to be able to see what the
-- AI asserted in order to argue with it.
--
-- provider/model record the ruling's provenance for the review card. Deliberately narrow: the
-- provider NAME and the served model id only, never a key, base URL, or header.
--
-- correction/corrected_by/corrected_at close the human loop: a DM's correction both re-labels
-- the claim and is replayed into subsequent turns' system prompts as authoritative.
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

-- Issue #599: the table safety hold (X-Card). ONE row per campaign holding the CURRENT
-- stop state — not an append-only log — because the only question every gate asks is
-- "is play frozen right now", and a single upserted row makes activation idempotent:
-- two participants tapping at once both succeed and the table pauses once.
--
-- There is NO activated_by_user_id column, on purpose. An anonymous activation must not
-- be attributable through a back door, and the cheapest way to guarantee that is for the
-- identity never to reach storage: the controller drops it before calling the service, so
-- there is no column for a future projection to forget to redact and nothing for a DM
-- reading the audit log to join against. activated_by_name is written ONLY for an
-- explicitly attributed activation and is NULL for both "anonymous" and "no hold".
--
-- released_by is the opposite case and is always recorded: releasing is an accountable
-- facilitator act, not a protected one.
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

CREATE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub);
CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id);
CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quests(campaign_id);
CREATE INDEX IF NOT EXISTS idx_quest_objectives_quest ON quest_objectives(quest_id);
CREATE INDEX IF NOT EXISTS idx_story_arcs_campaign ON story_arcs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_story_beats_arc ON story_beats(arc_id);
CREATE INDEX IF NOT EXISTS idx_story_beats_campaign ON story_beats(campaign_id);
CREATE INDEX IF NOT EXISTS idx_story_branches_beat ON story_branches(beat_id);
-- #617: timeline list orders by DM-controlled sort_index, id tiebreaker.
CREATE INDEX IF NOT EXISTS idx_timeline_events_campaign_sort
  ON timeline_events(campaign_id, sort_index, id);
CREATE INDEX IF NOT EXISTS idx_npcs_campaign ON npcs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_locations_campaign ON locations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_session_attendees_session ON session_attendees(session_id);
CREATE INDEX IF NOT EXISTS idx_session_attendees_character ON session_attendees(character_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_session ON session_shares(session_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_campaign ON session_shares(campaign_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_expiry ON session_shares(expires_at);
-- #617: schedule calendar reads order by scheduled_at, id tiebreaker.
CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_campaign_at
  ON scheduled_sessions(campaign_id, scheduled_at, id);
CREATE INDEX IF NOT EXISTS idx_session_rsvps_schedule ON session_rsvps(scheduled_session_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_ics_token ON campaigns(ics_token);
-- #116: normal campaign listings filter deleted_at IS NULL; the trash view filters
-- IS NOT NULL. Index it so both are index scans rather than full-table filters.
CREATE INDEX IF NOT EXISTS idx_campaigns_deleted_at ON campaigns(deleted_at);
-- #617: notes/inbox lists are always campaign-scoped and newest-first (id DESC);
-- resolved inbox history orders by updated_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS idx_notes_campaign_id_desc ON notes(campaign_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_inbox_resolved
  ON notes(campaign_id, kind, resolved, updated_at DESC, id DESC);
-- #123 / #617: comment threads are read for one entity (campaign + type + id),
-- oldest-first (id ASC); campaign-wide search walks (campaign_id, id).
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(campaign_id, entity_type, entity_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_campaign_id ON comments(campaign_id, id);
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
CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user ON password_reset_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_members_campaign ON campaign_members(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_members_user ON campaign_members(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_catch_up_campaign ON campaign_catch_up_cursors(campaign_id);
-- Issue #819: exclusive character seat — at most one membership may link a given
-- character. Partial so unlinked (NULL) seats do not collide. Matches migration 0067.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_members_character
  ON campaign_members(character_id) WHERE character_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_participant_support_campaign ON participant_support_preferences(campaign_id);
CREATE INDEX IF NOT EXISTS idx_participant_support_ai_consent ON participant_support_preferences(campaign_id, ai_use_consent);
CREATE INDEX IF NOT EXISTS idx_campaign_invites_campaign ON campaign_invites(campaign_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_user ON oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_family ON oauth_access_tokens(family_id);
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
-- Keep both: the single-column index matches other entity tables and covers
-- campaign-only lookups; (campaign_id, state) covers reserved/committed filters
-- used by publication recovery and public reads without relying on prefix quirks.
CREATE INDEX IF NOT EXISTS idx_attachments_campaign ON attachments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_attachments_campaign_state ON attachments(campaign_id, state);
CREATE INDEX IF NOT EXISTS idx_encounters_campaign ON encounters(campaign_id);
CREATE INDEX IF NOT EXISTS idx_encounters_status ON encounters(status);
CREATE INDEX IF NOT EXISTS idx_combatants_encounter ON combatants(encounter_id);
-- Issue #749: partial UNIQUE indexes that enforce "at most one row per
-- (encounter, identity)" at the DB boundary. A character (and likewise an NPC)
-- may appear at most once in an encounter; the service layer's pre-check is a
-- SELECT-then-INSERT (TOCTOU), so two concurrent adds of the same identity both
-- passed the probe and inserted. These partial indexes — scoped to non-NULL
-- identity so monster/NPC-less/character-less rows are exempt — turn the loser
-- of that race into a caught SQLITE_CONSTRAINT_UNIQUE instead of a silent
-- duplicate (which the service maps to a deterministic 409 with the winning
-- combatant id). Pre-existing duplicate rows on upgraded DBs are collapsed by
-- migration 0054 before this CREATE runs, so the index builds cleanly. The
-- classic kind='monster' rows (character_id AND npc_id both NULL) are never
-- constrained — duplicates there are intentional ("three Goblins", issue #114).
CREATE UNIQUE INDEX IF NOT EXISTS idx_combatants_encounter_character ON combatants(encounter_id, character_id) WHERE character_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_combatants_encounter_npc ON combatants(encounter_id, npc_id) WHERE npc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_encounter_events_encounter ON encounter_events(encounter_id);
-- #617: shared roll feed and retention prune are campaign-scoped, newest-first.
CREATE INDEX IF NOT EXISTS idx_dice_rolls_campaign_id_desc ON dice_rolls(campaign_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_check_requests_campaign ON check_requests(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_check_requests_character ON check_requests(character_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_campaign ON inventory_items(campaign_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_character ON inventory_items(character_id);
CREATE INDEX IF NOT EXISTS idx_inventory_qty_idempotency_item ON inventory_qty_idempotency(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_qty_idempotency_created ON inventory_qty_idempotency(created_at);
CREATE INDEX IF NOT EXISTS idx_encounter_op_idempotency_created ON encounter_op_idempotency(created_at);
CREATE INDEX IF NOT EXISTS idx_encounter_op_idempotency_encounter ON encounter_op_idempotency(encounter_id);
-- #577: the grounding review card reads a campaign's most recent claims, newest first.
CREATE INDEX IF NOT EXISTS idx_ai_driver_grounding_campaign
  ON ai_driver_grounding_claims(campaign_id, id);
${CAMPAIGN_MODULES_DDL}`;

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

/**
 * Denormalized FTS5 index for campaign-wide search. A single virtual table keeps
 * the SearchService hot path bounded by MATCH + LIMIT while triggers below keep
 * each source table synchronized. The *_fold columns carry the small full-fold
 * cases SQLite's unicode61 tokenizer does not handle itself (notably ß -> ss);
 * SearchService still hydrates source rows and builds snippets from original
 * text so response spelling and role redaction stay unchanged.
 */
export const CAMPAIGN_SEARCH_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS campaign_search_fts USING fts5(
  campaign_id UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  title,
  name,
  body,
  aux,
  dm_secret,
  title_fold,
  name_fold,
  body_fold,
  aux_fold,
  dm_secret_fold,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS campaign_search_quests_ai AFTER INSERT ON quests BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 1, new.campaign_id, 'quest', new.id, new.title, '', new.body, new.reward, new.dm_secret,
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.reward, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_quests_ad AFTER DELETE ON quests BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 1;
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  SELECT e.id * 32 + 13, e.campaign_id, 'encounter', e.id, '', e.name, '',
    trim(coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
    trim(coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
    '', replace(replace(replace(coalesce(e.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(trim(coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
  FROM encounters e
  LEFT JOIN locations l ON l.id = e.location_id AND l.campaign_id = e.campaign_id
  LEFT JOIN sessions s ON s.id = e.session_id AND s.campaign_id = e.campaign_id
  WHERE e.quest_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_quests_au AFTER UPDATE ON quests BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 1, new.campaign_id, 'quest', new.id, new.title, '', new.body, new.reward, new.dm_secret,
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.reward, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  SELECT e.id * 32 + 13, e.campaign_id, 'encounter', e.id, '', e.name, '',
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
    '', replace(replace(replace(coalesce(e.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
  FROM encounters e
  LEFT JOIN quests q ON q.id = e.quest_id AND q.campaign_id = e.campaign_id
  LEFT JOIN locations l ON l.id = e.location_id AND l.campaign_id = e.campaign_id
  LEFT JOIN sessions s ON s.id = e.session_id AND s.campaign_id = e.campaign_id
  WHERE e.quest_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_npcs_ai AFTER INSERT ON npcs BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 2, new.campaign_id, 'npc', new.id, '', new.name, new.body, new.role, new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.role, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_npcs_ad AFTER DELETE ON npcs BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 2;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_npcs_au AFTER UPDATE ON npcs BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 2, new.campaign_id, 'npc', new.id, '', new.name, new.body, new.role, new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.role, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_factions_ai AFTER INSERT ON factions BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 3, new.campaign_id, 'faction', new.id, '', new.name, new.body, trim(new.kind || ' ' || new.goals), new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(new.kind, '') || ' ' || coalesce(new.goals, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_factions_ad AFTER DELETE ON factions BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 3;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_factions_au AFTER UPDATE ON factions BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 3, new.campaign_id, 'faction', new.id, '', new.name, new.body, trim(new.kind || ' ' || new.goals), new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(new.kind, '') || ' ' || coalesce(new.goals, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_locations_ai AFTER INSERT ON locations BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 4, new.campaign_id, 'location', new.id, '', new.name, new.body, new.kind, new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.kind, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_locations_ad AFTER DELETE ON locations BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 4;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_locations_au AFTER UPDATE ON locations BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 4, new.campaign_id, 'location', new.id, '', new.name, new.body, new.kind, new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.kind, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  SELECT e.id * 32 + 13, e.campaign_id, 'encounter', e.id, '', e.name, '',
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
    '', replace(replace(replace(coalesce(e.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
  FROM encounters e
  LEFT JOIN quests q ON q.id = e.quest_id AND q.campaign_id = e.campaign_id
  LEFT JOIN locations l ON l.id = e.location_id AND l.campaign_id = e.campaign_id
  LEFT JOIN sessions s ON s.id = e.session_id AND s.campaign_id = e.campaign_id
  WHERE e.location_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_characters_ai AFTER INSERT ON characters BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 5, new.campaign_id, 'character', new.id, '', new.name, new.notes, trim(new.species || ' ' || new.class_name || ' ' || new.background), new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(new.species, '') || ' ' || coalesce(new.class_name, '') || ' ' || coalesce(new.background, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_characters_ad AFTER DELETE ON characters BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 5;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_characters_au AFTER UPDATE ON characters BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 5, new.campaign_id, 'character', new.id, '', new.name, new.notes, trim(new.species || ' ' || new.class_name || ' ' || new.background), new.dm_secret, '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(new.species, '') || ' ' || coalesce(new.class_name, '') || ' ' || coalesce(new.background, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 6, new.campaign_id, 'session', new.id, case when length(trim(coalesce(new.title, ''))) > 0 then new.title else 'Session ' || new.number end, '', new.recap, '', new.dm_secret,
    replace(replace(replace(coalesce(case when length(trim(coalesce(new.title, ''))) > 0 then new.title else 'Session ' || new.number end, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.recap, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_sessions_ad AFTER DELETE ON sessions BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 6;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_sessions_au AFTER UPDATE ON sessions BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 6, new.campaign_id, 'session', new.id, case when length(trim(coalesce(new.title, ''))) > 0 then new.title else 'Session ' || new.number end, '', new.recap, '', new.dm_secret,
    replace(replace(replace(coalesce(case when length(trim(coalesce(new.title, ''))) > 0 then new.title else 'Session ' || new.number end, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.recap, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  SELECT e.id * 32 + 13, e.campaign_id, 'encounter', e.id, '', e.name, '',
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
    '', replace(replace(replace(coalesce(e.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
  FROM encounters e
  LEFT JOIN quests q ON q.id = e.quest_id AND q.campaign_id = e.campaign_id
  LEFT JOIN locations l ON l.id = e.location_id AND l.campaign_id = e.campaign_id
  LEFT JOIN sessions s ON s.id = e.session_id AND s.campaign_id = e.campaign_id
  WHERE e.session_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_notes_ai AFTER INSERT ON notes BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 7, new.campaign_id, 'note', new.id, '', '', new.body, '', '', '', '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 7;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_notes_au AFTER UPDATE ON notes BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 7, new.campaign_id, 'note', new.id, '', '', new.body, '', '', '', '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_timeline_ai AFTER INSERT ON timeline_events BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 8, new.campaign_id, 'timeline', new.id, new.title, '', new.body, trim(new.in_world_date || ' ' || new.era), new.dm_secret,
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(new.in_world_date, '') || ' ' || coalesce(new.era, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_timeline_ad AFTER DELETE ON timeline_events BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 8;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_timeline_au AFTER UPDATE ON timeline_events BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 8, new.campaign_id, 'timeline', new.id, new.title, '', new.body, trim(new.in_world_date || ' ' || new.era), new.dm_secret,
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(new.in_world_date, '') || ' ' || coalesce(new.era, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'));
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_inventory_ai AFTER INSERT ON inventory_items BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 9, new.campaign_id, 'item', new.id, '', new.name, '', new.notes, '', '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '');
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_inventory_ad AFTER DELETE ON inventory_items BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 9;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_inventory_au AFTER UPDATE ON inventory_items BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 9, new.campaign_id, 'item', new.id, '', new.name, '', new.notes, '', '',
    replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '');
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_comments_ai AFTER INSERT ON comments BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 10, new.campaign_id, 'comment', new.id, '', '', new.body, '', '', '', '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_comments_ad AFTER DELETE ON comments BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 10;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_comments_au AFTER UPDATE ON comments BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 10, new.campaign_id, 'comment', new.id, '', '', new.body, '', '', '', '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_arcs_ai AFTER INSERT ON story_arcs BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 11, new.campaign_id, 'arc', new.id, new.title, '', new.summary, '', '',
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.summary, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_arcs_ad AFTER DELETE ON story_arcs BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 11;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_arcs_au AFTER UPDATE ON story_arcs BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 11, new.campaign_id, 'arc', new.id, new.title, '', new.summary, '', '',
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.summary, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_beats_ai AFTER INSERT ON story_beats BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 12, new.campaign_id, 'beat', new.id, new.title, '', new.body, '', '',
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_beats_ad AFTER DELETE ON story_beats BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 12;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_beats_au AFTER UPDATE ON story_beats BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 12, new.campaign_id, 'beat', new.id, new.title, '', new.body, '', '',
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '');
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_encounters_ai AFTER INSERT ON encounters BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  SELECT new.id * 32 + 13, new.campaign_id, 'encounter', new.id, '', new.name, '',
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
    '', replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
  FROM (SELECT 1) one
  LEFT JOIN quests q ON q.id = new.quest_id AND q.campaign_id = new.campaign_id
  LEFT JOIN locations l ON l.id = new.location_id AND l.campaign_id = new.campaign_id
  LEFT JOIN sessions s ON s.id = new.session_id AND s.campaign_id = new.campaign_id;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_encounters_ad AFTER DELETE ON encounters BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 13;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_encounters_au AFTER UPDATE ON encounters BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = new.id * 32 + 13;
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  SELECT new.id * 32 + 13, new.campaign_id, 'encounter', new.id, '', new.name, '',
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
    trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
    '', replace(replace(replace(coalesce(new.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
         coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
         coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
  FROM (SELECT 1) one
  LEFT JOIN quests q ON q.id = new.quest_id AND q.campaign_id = new.campaign_id
  LEFT JOIN locations l ON l.id = new.location_id AND l.campaign_id = new.campaign_id
  LEFT JOIN sessions s ON s.id = new.session_id AND s.campaign_id = new.campaign_id;
END;

CREATE TRIGGER IF NOT EXISTS campaign_search_scheduled_sessions_ai AFTER INSERT ON scheduled_sessions BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 14, new.campaign_id, 'scheduled_session', new.id, new.title, '', new.notes,
    new.scheduled_at || ' ' || replace(replace(replace(new.scheduled_at, 'T', ' '), ':', ' '), '-', ' '), '',
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.scheduled_at || ' ' || replace(replace(replace(new.scheduled_at, 'T', ' '), ':', ' '), '-', ' '), ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '');
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_scheduled_sessions_ad AFTER DELETE ON scheduled_sessions BEGIN
  DELETE FROM campaign_search_fts WHERE rowid = old.id * 32 + 14;
END;
CREATE TRIGGER IF NOT EXISTS campaign_search_scheduled_sessions_au AFTER UPDATE ON scheduled_sessions BEGIN
  INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
  VALUES (new.id * 32 + 14, new.campaign_id, 'scheduled_session', new.id, new.title, '', new.notes,
    new.scheduled_at || ' ' || replace(replace(replace(new.scheduled_at, 'T', ' '), ':', ' '), '-', ' '), '',
    replace(replace(replace(coalesce(new.title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
    replace(replace(replace(coalesce(new.notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
    replace(replace(replace(coalesce(new.scheduled_at || ' ' || replace(replace(replace(new.scheduled_at, 'T', ' '), ':', ' '), '-', ' '), ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '');
END;

DELETE FROM campaign_search_fts;

INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 1, campaign_id, 'quest', id, title, '', body, reward, dm_secret,
  replace(replace(replace(coalesce(title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(reward, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM quests;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 2, campaign_id, 'npc', id, '', name, body, role, dm_secret, '',
  replace(replace(replace(coalesce(name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(role, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM npcs;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 3, campaign_id, 'faction', id, '', name, body, trim(kind || ' ' || goals), dm_secret, '',
  replace(replace(replace(coalesce(name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(trim(coalesce(kind, '') || ' ' || coalesce(goals, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM factions;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 4, campaign_id, 'location', id, '', name, body, kind, dm_secret, '',
  replace(replace(replace(coalesce(name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(kind, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM locations;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 5, campaign_id, 'character', id, '', name, notes, trim(species || ' ' || class_name || ' ' || background), dm_secret, '',
  replace(replace(replace(coalesce(name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(trim(coalesce(species, '') || ' ' || coalesce(class_name, '') || ' ' || coalesce(background, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM characters;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 6, campaign_id, 'session', id, case when length(trim(coalesce(title, ''))) > 0 then title else 'Session ' || number end, '', recap, '', dm_secret,
  replace(replace(replace(coalesce(case when length(trim(coalesce(title, ''))) > 0 then title else 'Session ' || number end, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(recap, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM sessions;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 7, campaign_id, 'note', id, '', '', body, '', '', '', '',
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '' FROM notes;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 8, campaign_id, 'timeline', id, title, '', body, trim(in_world_date || ' ' || era), dm_secret,
  replace(replace(replace(coalesce(title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(trim(coalesce(in_world_date, '') || ' ' || coalesce(era, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(dm_secret, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i') FROM timeline_events;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 9, campaign_id, 'item', id, '', name, '', notes, '', '',
  replace(replace(replace(coalesce(name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '' FROM inventory_items;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 10, campaign_id, 'comment', id, '', '', body, '', '', '', '',
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '' FROM comments;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 11, campaign_id, 'arc', id, title, '', summary, '', '',
  replace(replace(replace(coalesce(title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(summary, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '' FROM story_arcs;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 12, campaign_id, 'beat', id, title, '', body, '', '',
  replace(replace(replace(coalesce(title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(body, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '', '' FROM story_beats;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT e.id * 32 + 13, e.campaign_id, 'encounter', e.id, '', e.name, '',
  trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
       coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
       coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')),
  trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
       coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')),
  '', replace(replace(replace(coalesce(e.name, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden = 0 then q.title else '' end, '') || ' ' ||
       coalesce(case when l.id is not null and l.deleted_at is null and l.status <> 'unexplored' then l.name else '' end, '') || ' ' ||
       coalesce(case when s.id is not null and s.deleted_at is null then case when length(trim(coalesce(s.title, ''))) > 0 then s.title else 'Session ' || s.number end else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(trim(coalesce(case when q.id is not null and q.deleted_at is null and q.hidden <> 0 then q.title else '' end, '') || ' ' ||
       coalesce(case when l.id is not null and l.deleted_at is null and l.status = 'unexplored' then l.name else '' end, '')), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i')
FROM encounters e
LEFT JOIN quests q ON q.id = e.quest_id AND q.campaign_id = e.campaign_id
LEFT JOIN locations l ON l.id = e.location_id AND l.campaign_id = e.campaign_id
LEFT JOIN sessions s ON s.id = e.session_id AND s.campaign_id = e.campaign_id;
INSERT OR REPLACE INTO campaign_search_fts(rowid, campaign_id, entity_type, entity_id, title, name, body, aux, dm_secret, title_fold, name_fold, body_fold, aux_fold, dm_secret_fold)
SELECT id * 32 + 14, campaign_id, 'scheduled_session', id, title, '', notes,
  scheduled_at || ' ' || replace(replace(replace(scheduled_at, 'T', ' '), ':', ' '), '-', ' '), '',
  replace(replace(replace(coalesce(title, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '',
  replace(replace(replace(coalesce(notes, ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'),
  replace(replace(replace(coalesce(scheduled_at || ' ' || replace(replace(replace(scheduled_at, 'T', ' '), ':', ' '), '-', ' '), ''), 'ß', 'ss'), 'ẞ', 'ss'), 'İ', 'i'), '' FROM scheduled_sessions;
`;
