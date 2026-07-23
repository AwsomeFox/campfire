import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle table definitions mirroring @campfire/schema entities.
 *
 * JSON-ish fields (stats, conditions) are stored as TEXT and (de)serialized
 * in the service layer — see src/common/json.ts.
 */

export const campaigns = sqliteTable('campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('active'),
  currentLocationId: integer('current_location_id'),
  dangerLevel: text('danger_level').notNull().default('low'),
  // When true, only the DM may award XP / level up characters (issue #270). Added in
  // older DBs via migrateCampaignsTableForDmControlsProgression() — see db/db.module.ts.
  dmControlsProgression: integer('dm_controls_progression', { mode: 'boolean' }).notNull().default(false),
  publicRecapSharingEnabled: integer('public_recap_sharing_enabled', { mode: 'boolean' }).notNull().default(true),
  // Issue #857: when false, public invite preview/accept/join all 404 with the
  // uniform inactive message. Archive/trash auto-clears this; restore/unarchive
  // does NOT flip it back — deliberate reactivation via the invites policy
  // endpoint is required. Nullable in older DBs pre-migration; see db.module.ts.
  publicInvitesEnabled: integer('public_invites_enabled', { mode: 'boolean' }).notNull().default(true),
  sessionCount: integer('session_count').notNull().default(0),
  // Slug of the installed rule pack (see rulePacks.slug) powering this campaign, or '' if unset.
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  ruleSystem: text('rule_system').notNull().default(''),
  // Attachment (kind='map') rendered as the campaign map background on Dashboard/Location detail.
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  mapAttachmentId: integer('map_attachment_id'),
  // Unguessable capability secret (cf_ics_<48 hex>) for the public ICS calendar feed,
  // or null when the feed is disabled. Stored plaintext (unlike session/PAT hashes) so
  // the feed URL can be re-displayed to members — see modules/sessions/scheduling.
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  icsToken: text('ics_token'),
  // Issue #554: absolute expiry (ISO UTC) after which the feed token stops authorizing
  // the public .ics endpoint (a leaked URL self-destructs on a schedule). Nullable for
  // back-compat — legacy rows written before this column existed have no expiry and keep
  // working until the DM rotates (which always stamps a fresh expiry). Cleared alongside
  // icsToken on disableFeed. See migrateCampaignsTableForIcsTokenExpiresAt.
  icsTokenExpiresAt: text('ics_token_expires_at'),
  // Per-campaign upload quota in bytes, or NULL for no limit (issue #24). Admin-set
  // via the storage console; enforced on attachment upload. Nullable in older DBs
  // pre-migration; see db/db.module.ts ALTER TABLE note.
  storageQuotaBytes: integer('storage_quota_bytes'),
  // The single authoritative live encounter for this campaign (issue #744). A campaign
  // may have at most one 'running' fight — Start/Reopen set this pointer inside the
  // same transaction that flips status to 'running', and End clears it. Dashboard /
  // Player Display / AI Table read this (falling back to a 'running' scan for back-compat)
  // instead of picking an arbitrary first result. Nullable in older DBs pre-migration;
  // see db/db.module.ts migrateCampaignsTableForActiveEncounter().
  activeEncounterId: integer('active_encounter_id'),
  // Soft-delete / trash timestamp (issue #116). NULL => live; an ISO timestamp => the
  // campaign is trashed: excluded from normal listings while its rows + on-disk uploads
  // survive for a grace period, restorable until an explicit purge. Migrated via
  // migrateSoftDeleteColumns() in db/db.module.ts.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  ownerUserId: text('owner_user_id'),
  name: text('name').notNull(),
  species: text('species').notNull().default(''),
  className: text('class_name').notNull().default(''),
  level: integer('level').notNull().default(1),
  xp: integer('xp').notNull().default(0),
  background: text('background').notNull().default(''),
  // Lifecycle status: active|dead|retired|inactive (issue #115). Only 'active' PCs are
  // auto-added to a new encounter. Nullable in older DBs pre-migration; see
  // db/db.module.ts ALTER TABLE note.
  status: text('status').notNull().default('active'),
  stats: text('stats').notNull().default('{}'),
  ac: integer('ac'),
  hpCurrent: integer('hp_current').notNull().default(10),
  hpMax: integer('hp_max').notNull().default(10),
  // Issue #711: the combat death/temp-HP subsystem (issue #57) mirrored back
  // from the encounter at /end. `hpTemp` is the carried-over temp-HP pool; the
  // three death-save fields echo the combatant lifecycle so a dead PC stays
  // visibly dead on the sheet and is skipped by the next encounter's auto-add.
  hpTemp: integer('hp_temp').notNull().default(0),
  deathState: text('death_state').notNull().default('none'),
  deathSaveSuccesses: integer('death_save_successes').notNull().default(0),
  deathSaveFailures: integer('death_save_failures').notNull().default(0),
  conditions: text('conditions').notNull().default('[]'),
  saveProficiencies: text('save_proficiencies').notNull().default('[]'),
  skills: text('skills').notNull().default('{}'),
  actions: text('actions').notNull().default('[]'),
  spellSlots: text('spell_slots').notNull().default('{}'),
  portraitUrl: text('portrait_url'),
  ddbId: text('ddb_id'),
  notes: text('notes').notNull().default(''),
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  dmSecret: text('dm_secret').notNull().default(''),
  // Soft-delete / trash timestamp (issue #116) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const quests = sqliteTable('quests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  parentId: integer('parent_id'),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  status: text('status').notNull().default('available'),
  giverNpcId: integer('giver_npc_id'),
  reward: text('reward').notNull().default(''),
  dmSecret: text('dm_secret').notNull().default(''),
  // Entity-level secrecy (issue #42): hidden quests are excluded wholesale from
  // non-DM reads. Nullable/absent in older DBs pre-migration; see db/db.module.ts
  // migrateQuestsTableForHidden().
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  // Soft-delete / trash timestamp (issue #116) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const questObjectives = sqliteTable('quest_objectives', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  questId: integer('quest_id').notNull(),
  text: text('text').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

// ---------- storylines (issue #27) — DM-only branching arc/beat planner ----------
export const storyArcs = sqliteTable('story_arcs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  status: text('status').notNull().default('planned'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const storyBeats = sqliteTable('story_beats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  arcId: integer('arc_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  status: text('status').notNull().default('planned'),
  sortOrder: integer('sort_order').notNull().default(0),
  // Optional links to the play record this planned beat corresponds to (issue #264) —
  // the session it landed in, the quest it advanced, the encounter that resolved it.
  // Nullable; added by migration on older DBs (0036_story_beats_links in db/db.module.ts).
  sessionId: integer('session_id'),
  questId: integer('quest_id'),
  encounterId: integer('encounter_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Timeline (in-world calendar / campaign timeline) — issue #63. Standalone module.
export const timelineEvents = sqliteTable('timeline_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  title: text('title').notNull(),
  inWorldDate: text('in_world_date').notNull().default(''),
  body: text('body').notNull().default(''),
  era: text('era').notNull().default(''),
  sortIndex: integer('sort_index').notNull().default(0),
  dmSecret: text('dm_secret').notNull().default(''),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// A branch is a labelled, ordered edge FROM a beat TO an optional next beat.
export const storyBranches = sqliteTable('story_branches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  beatId: integer('beat_id').notNull(),
  toBeatId: integer('to_beat_id'),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

// One "current in-world date" row per campaign (the issue's honest v0). campaignId
// is UNIQUE so the module upserts rather than accumulating rows.
export const timelineCalendars = sqliteTable('timeline_calendars', {
  campaignId: integer('campaign_id').primaryKey(),
  currentDate: text('current_date').notNull().default(''),
  note: text('note').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Session zero / table charter (safety tools & expectations) — issue #122. One row
// per campaign (campaignId PK), upserted like timeline_calendars. lines/veils/
// safetyTools are string arrays stored as JSON text (see common/json.ts); the rest is
// markdown. Member-readable, DM-authored — no dmSecret (a safety record the whole
// table must see).
export const sessionZero = sqliteTable('session_zero', {
  campaignId: integer('campaign_id').primaryKey(),
  lines: text('lines').notNull().default('[]'),
  veils: text('veils').notNull().default('[]'),
  safetyTools: text('safety_tools').notNull().default('[]'),
  houseRules: text('house_rules').notNull().default(''),
  toneAndExpectations: text('tone_and_expectations').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Participant-owned practical access supports (issue #877). owner_user_id uses
// the same identity space as notes/characters (real numeric ids serialized as
// strings, plus dev:* identities in explicit DEV_AUTH environments). Lifecycle
// paths delete these rows explicitly when the participant leaves/is removed.
export const participantSupportPreferences = sqliteTable(
  'participant_support_preferences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    ownerName: text('owner_name').notNull().default(''),
    supportText: text('support_text').notNull(),
    visibility: text('visibility').notNull().default('facilitator'),
    aiUseConsent: integer('ai_use_consent', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    campaignOwnerUnique: uniqueIndex('idx_participant_support_campaign_owner').on(table.campaignId, table.ownerUserId),
  }),
);

export const npcs = sqliteTable('npcs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull().default(''),
  disposition: text('disposition').notNull().default('neutral'),
  locationId: integer('location_id'),
  // Faction/organization membership (issue #221). Nullable/absent in older DBs
  // pre-migration; see db/db.module.ts migrateNpcsTableForFactionId().
  factionId: integer('faction_id'),
  body: text('body').notNull().default(''),
  dmSecret: text('dm_secret').notNull().default(''),
  // Slug of a bundled game-icons.net entity icon (issue #302), or '' for none.
  // Nullable/absent in older DBs pre-migration; see migrateNpcsTableForIconSlug().
  iconSlug: text('icon_slug').notNull().default(''),
  // Entity-level secrecy (issue #42) — see quests.hidden. Migrated via
  // migrateNpcsTableForHidden() in db/db.module.ts.
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  // Soft-delete / trash timestamp (issue #116) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Faction/organization entity (issue #221). Mirrors npcs: dmSecret + hidden secrecy,
// plus a party-reputation model (numeric reputation score + coarse standing label).
export const factions = sqliteTable('factions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default(''),
  body: text('body').notNull().default(''),
  goals: text('goals').notNull().default(''),
  dmSecret: text('dm_secret').notNull().default(''),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  reputation: integer('reputation').notNull().default(0),
  standing: text('standing').notNull().default('neutral'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const locations = sqliteTable('locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  // Self-referencing parent for location nesting (region→city→dungeon→room, #99).
  // Nullable/absent in older DBs pre-migration; see db/db.module.ts
  // migrateLocationsTableForParentId().
  parentId: integer('parent_id'),
  name: text('name').notNull(),
  kind: text('kind').notNull().default(''),
  status: text('status').notNull().default('unexplored'),
  mapX: real('map_x'),
  mapY: real('map_y'),
  body: text('body').notNull().default(''),
  dmSecret: text('dm_secret').notNull().default(''),
  // Soft-delete / trash timestamp (issue #116) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull().default(''),
  playedAt: text('played_at'),
  recap: text('recap').notNull().default(''),
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  dmSecret: text('dm_secret').notNull().default(''),
  // Soft-delete / trash timestamp (issue #116) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Per-session attendance (issue #121) — which characters played a given session.
// West Marches / rotating-cast tables need a "who was there" record instead of the
// party being all-or-nothing. One row per (session, character); the set is replaced
// wholesale on write. character_name is a write-time snapshot retained as a
// compatibility fallback; normal reads prefer the current characters.name via a
// LEFT JOIN so character renames cannot make attendance drift (issue #659).
export const sessionAttendees = sqliteTable('session_attendees', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  characterId: integer('character_id').notNull(),
  characterName: text('character_name').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

// Read-only recap share links (see modules/sessions/session-shares.service.ts).
// DB stores sha256(token) only — the raw token lives in the shared URL and is
// shown once at creation. Deleting a row revokes the link.
export const sessionShares = sqliteTable('session_shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  label: text('label').notNull().default(''),
  createdBy: text('created_by').notNull().default(''),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  expiresAt: text('expires_at'),
  accessCount: integer('access_count').notNull().default(0),
  firstAccessedAt: text('first_accessed_at'),
  lastAccessedAt: text('last_accessed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Planned (future) game nights — distinct from `sessions` above, which are play
// logs of sessions that already happened. See modules/sessions/scheduling.
export const scheduledSessions = sqliteTable('scheduled_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  scheduledAt: text('scheduled_at').notNull(), // ISO UTC (normalized on write)
  durationMinutes: integer('duration_minutes').notNull().default(240),
  title: text('title').notNull().default(''),
  location: text('location').notNull().default(''),
  notes: text('notes').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Per-member availability for a scheduled session. One row per (schedule, user) —
// upserted on PUT /schedule/:id/rsvp. userId is TEXT like notes.author_user_id.
export const sessionRsvps = sqliteTable('session_rsvps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scheduledSessionId: integer('scheduled_session_id').notNull(),
  userId: text('user_id').notNull(),
  userName: text('user_name').notNull().default(''),
  status: text('status').notNull(), // 'yes' | 'no' | 'maybe'
  note: text('note').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  authorUserId: text('author_user_id').notNull(),
  authorName: text('author_name').notNull().default(''),
  kind: text('kind').notNull().default('note'),
  visibility: text('visibility').notNull().default('private'),
  entityType: text('entity_type'),
  entityId: integer('entity_id'),
  // Target member for a `whisper` note (issue #127) — String(users.id) or dev:<name>,
  // same identity space as author_user_id. Null for every other visibility. Nullable/
  // absent in older DBs pre-migration; see db/db.module.ts migrateNotesTableForRecipient().
  recipientUserId: text('recipient_user_id'),
  body: text('body').notNull(),
  resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
  resolvedNote: text('resolved_note').notNull().default(''),
  // Soft-delete / trash timestamp (issue #116) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Threaded discussion layer (issue #123). Distinct from notes: always anchored
// to an entity, always visible to all campaign members, one level of threading
// via parent_id, optional in-character flag.
//
// Soft delete / tombstone (issue #503): deleting a top-level comment that has
// other members' replies must NOT destroy them. Instead the row is tombstoned
// (deleted_at set, body redacted in responses) so replies keep their parent
// pointer and the thread topology stays intact. A tombstoned root is still
// returned by list/get (as a placeholder) — unlike notes/campaigns, the row is
// NOT filtered out of normal reads, because replies reference it. deleted_by
// records who pulled the trigger (the author or a DM moderating) WHILE the row
// is tombstoned, so the UI can render "[deleted by author]" vs "[deleted by
// moderator]". It is cleared on restore, so durable provenance of a past
// tombstone (who/when) lives in the AUDIT LOG, not on this row.
export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: integer('entity_id').notNull(),
  parentId: integer('parent_id'),
  authorUserId: text('author_user_id').notNull(),
  authorName: text('author_name').notNull().default(''),
  body: text('body').notNull(),
  inCharacter: integer('in_character', { mode: 'boolean' }).notNull().default(false),
  // Immutable creation-time character attribution (issue #787). character_id is
  // deliberately a soft reference: deleting/trashed characters must not erase or
  // rewrite historical dialogue. The copied name/avatar remain display-authoritative.
  characterId: integer('character_id'),
  characterName: text('character_name'),
  characterAvatarUrl: text('character_avatar_url'),
  // Soft delete / tombstone (issue #503). NULL = live; an ISO timestamp means the
  // comment is tombstoned (body redacted in API responses, replies preserved).
  // Nullable/absent in older DBs pre-migration; see db/db.module.ts migrateCommentsTableForSoftDelete().
  deletedAt: text('deleted_at'),
  // Who tombstoned it: String(users.id), 'dev:<name>', or 'token:<name>' — same
  // identity space as author_user_id. Null on a live row. Cleared on restore.
  deletedBy: text('deleted_by'),
  // Editor provenance for the TRUST case (issue #783): a DM editing another
  // member's comment must NOT leave the original author as the apparent writer of
  // text they didn't write. edited_at is stamped (alongside the usual updated_at
  // bump) ONLY when the editor is not the original author, and edited_by records
  // that editor in the same identity space as author_user_id / deleted_by. A
  // self-edit leaves both NULL — the author editing their own prose is not a
  // provenance event, and updated_at already drives the UI's "edited" badge.
  // The original author_user_id / author_name are NEVER overwritten by an edit,
  // so the player who wrote the comment stays its author of record.
  editedAt: text('edited_at'),
  editedBy: text('edited_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Prose revision history (issue #157) — one row per committed prose update, holding a
// snapshot of the entity's PRIOR content so a blind last-write-wins overwrite can be
// listed and restored. entity_type/entity_id is a polymorphic (soft) reference across
// sessions/quests/npcs/locations — no single FK can cover it, so the owning service's
// remove() deletes this entity's revisions (mirroring session_attendees cleanup), and
// campaign_id carries the ON DELETE CASCADE that tears the whole tree down with a
// campaign. `snapshot` is a JSON string map of the prior prose field(s) (see json.ts).
export const entityRevisions = sqliteTable('entity_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  entityType: text('entity_type').notNull(), // 'session' | 'quest' | 'npc' | 'location' | 'faction' | 'note'
  entityId: integer('entity_id').notNull(),
  snapshot: text('snapshot').notNull().default('{}'), // JSON: { recap } | { body } — prose OF THIS VERSION
  // Version author (issue #813). Empty when authorship_known=0 (legacy rows).
  authorUserId: text('author_user_id').notNull().default(''),
  authorName: text('author_name').notNull().default(''),
  authorSource: text('author_source').notNull().default('human'), // 'human' | 'ai' | 'tool'
  authorSourceDetail: text('author_source_detail').notNull().default(''),
  createdAt: text('created_at').notNull().default(''), // authored-at; '' when unknown (legacy)
  // Replacing actor/time — null replaced_at marks the current tip (still live).
  replacedByUserId: text('replaced_by_user_id').notNull().default(''),
  replacedByName: text('replaced_by_name').notNull().default(''),
  replacedBySource: text('replaced_by_source').notNull().default('human'),
  replacedBySourceDetail: text('replaced_by_source_detail').notNull().default(''),
  replacedAt: text('replaced_at'),
  restoredFromRevisionId: integer('restored_from_revision_id'),
  // 0 for pre-#813 rows: UI must label "Replaced by …" rather than invent authorship.
  authorshipKnown: integer('authorship_known', { mode: 'boolean' }).notNull().default(true),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id'),
  actor: text('actor').notNull(),
  actorRole: text('actor_role').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: integer('entity_id'),
  detail: text('detail').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull().default(''),
  // Nullable: SSO-provisioned users (OIDC) have no local password. See
  // db/bootstrap.sql.ts for the ALTER TABLE migration note re: existing DBs.
  passwordHash: text('password_hash'),
  serverRole: text('server_role').notNull().default('user'),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  // OIDC subject claim ("sub"), unique per issuer. Null for local-only users.
  // Not compound-keyed on issuer: this app supports a single configured OIDC
  // issuer at a time (env-gated), so `sub` alone is enough to dedupe.
  oidcSub: text('oidc_sub'),
  // Personal accent color override (#rrggbb), or null to follow the server default.
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  accentColor: text('accent_color'),
  // Personal reading preference: 'default' | 'comfortable' | 'large'. The TEXT
  // column predates comfortable mode, so existing rows remain compatible and no
  // shape migration is required; strict values are enforced by the API schema.
  textSize: text('text_size').notNull().default('default'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const userSessions = sqliteTable('user_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  userId: integer('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
});

// Forgot-password flow (admin-approved, no mail transport needed): a @Public
// request creates a 'pending' row; an admin approving it sets codeHash (sha256
// of the one-time reset code — raw code shown to the admin ONCE) + expiresAt
// and flips status to 'approved'; redeeming the code deletes the row. See
// modules/auth/password-reset.service.ts.
export const passwordResetRequests = sqliteTable('password_reset_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'approved'
  codeHash: text('code_hash').unique(), // set when approved; never the raw code
  requestedAt: text('requested_at').notNull(),
  approvedAt: text('approved_at'),
  approvedBy: text('approved_by').notNull().default(''), // admin display name, audit only
  expiresAt: text('expires_at'), // set when approved
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Single-row install-identity table (issue #723). Carries the per-install UUID
 * (stable across backup/restore — it lives INSIDE the DB that gets restored) and
 * a monotonic `data_generation` that the server bumps on every whole-server
 * restore. Both are surfaced on /me (Me.instance) so the PWA can namespace its
 * SW runtime cache by `${instanceId}:${dataGeneration}` — a restore bumps the
 * generation, the next proven-live /me carries the new value, and the client
 * purges the prior cache so stale pre-restore bytes can't render (online or
 * offline). See modules/server-meta/server-meta.service.ts and
 * apps/web/src/lib/swCache.ts.
 *
 * The row is seeded lazily on first read (ServerMetaService.get) so a fresh DB
 * and a restored DB alike always have exactly one row with a real UUID.
 */
export const SERVER_META_KEY = 'singleton';
export const serverMeta = sqliteTable('server_meta', {
  key: text('key').primaryKey(),
  // Per-install UUID (e.g. "550e8400-e29b-..."). Generated once, then stable for
  // the life of the install — travels inside a backup so the same box keeps it
  // across restores (which is exactly why we ALSO need data_generation).
  instanceId: text('instance_id').notNull(),
  // Monotonic integer bumped by ServerMetaService.bumpGeneration() on a restore.
  // Starts at 0; the first restore moves it to 1, etc.
  dataGeneration: integer('data_generation').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

export const campaignMembers = sqliteTable('campaign_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  // A membership without a real account can never authenticate. Keep this FK in
  // the ORM schema as well as bootstrap/migration DDL so every write path and
  // every upgraded database enforces the same authority boundary (#849).
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  characterId: integer('character_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Safe, server-admin-visible history of membership rows repaired while adding
// the campaign_members.user_id FK (#849). This deliberately has no campaign/user
// FKs: it records references that were already missing and remains useful after
// later account/campaign cleanup. It contains identifiers and roles only — never
// campaign content or secrets.
export const membershipIntegrityRepairs = sqliteTable('membership_integrity_repairs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  memberId: integer('member_id').notNull(),
  userId: integer('user_id').notNull(),
  role: text('role').notNull(),
  reason: text('reason').notNull(),
  action: text('action').notNull(),
  invalidReferenceId: integer('invalid_reference_id'),
  createdAt: text('created_at').notNull(),
});

// DM invite links / join codes — see modules/membership/invites.service.ts.
// `code` is stored PLAINTEXT, unlike session/PAT tokens (which store sha256):
// an invite code is a shareable capability the DM re-displays and re-copies from
// the UI, and it can only create a NEW membership at a capped role (never dm) —
// it cannot impersonate an existing user. It is 128-bit random, always expiring,
// optionally use-capped, and revocable (row delete). Expired/exhausted rows are
// retained for operator inspection and whole-server backup; public code resolution
// and the DM list API filter them out, while revoke/campaign deletion remove them.
export const campaignInvites = sqliteTable('campaign_invites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  code: text('code').notNull().unique(),
  role: text('role').notNull(), // 'player' | 'viewer' — never 'dm'
  createdByUserId: integer('created_by_user_id'), // null when created by a dev:* header user (DEV_AUTH)
  expiresAt: text('expires_at').notNull(),
  maxUses: integer('max_uses'), // null = unlimited (until expiry/revocation)
  useCount: integer('use_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  name: text('name').notNull(),
  scope: text('scope').notNull(),
  // Server-enforced WRITE authority ('direct' | 'propose' | 'none'), orthogonal
  // to `scope` (which caps read/role). See WriteScope in @campfire/schema. Existing
  // DBs get this added via migrateApiTokensTableForWriteScope(), defaulting to
  // 'direct' — the safe/back-compat value: pre-existing tokens write exactly as
  // before, none are silently downgraded to read-only.
  writeScope: text('write_scope').notNull().default('direct'),
  campaignId: integer('campaign_id'),
  // See db/db.module.ts ALTER TABLE note — existing DBs get this added via
  // migrateApiTokensTableForAdminEnabled(), defaulting to 0 (false), which is the
  // safe/least-privilege value: pre-existing tokens never gain server-admin power.
  adminEnabled: integer('admin_enabled', { mode: 'boolean' }).notNull().default(false),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * MCP OAuth (issue #37) — Campfire as a minimal OAuth 2.1 authorization server.
 *
 * oauth_clients: RFC 7591 Dynamic Client Registration records. `clientId` is the
 * public identifier (`cf_client_...`), stored plaintext (an OAuth client_id is
 * not a secret). `secretHash` is sha256 of the client secret for confidential
 * clients (token_endpoint_auth_method != "none"); NULL for public/PKCE clients
 * like Claude. `redirectUris` / `grantTypes` / `responseTypes` are JSON arrays.
 */
export const oauthClients = sqliteTable('oauth_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: text('client_id').notNull().unique(),
  secretHash: text('secret_hash'), // null for public (PKCE) clients
  clientName: text('client_name').notNull().default(''),
  redirectUris: text('redirect_uris').notNull(), // JSON string[]
  grantTypes: text('grant_types').notNull(), // JSON string[]
  responseTypes: text('response_types').notNull(), // JSON string[]
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  scope: text('scope'), // requested scope string, or null
  createdAt: text('created_at').notNull(),
});

/**
 * oauth_auth_codes: one-time authorization codes issued by GET/POST /oauth/authorize
 * and redeemed once at the token endpoint. `codeHash` is sha256(`cf_oac_...`).
 * Captures the PKCE `codeChallenge` (validated against the presented verifier at
 * exchange), the bound `redirectUri`/`resource`, and the Campfire authorization
 * decision: `userId` (who consented), `roleScope` (dm|player|viewer cap) and
 * optional `campaignId` binding — mirroring a PAT's scope caps.
 */
export const oauthAuthCodes = sqliteTable('oauth_auth_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codeHash: text('code_hash').notNull().unique(),
  clientId: text('client_id').notNull(),
  userId: integer('user_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  scope: text('scope'), // granted OAuth scope string
  resource: text('resource'), // RFC 8707 resource indicator, or null
  roleScope: text('role_scope').notNull().default('dm'), // Campfire role cap
  campaignId: integer('campaign_id'), // optional single-campaign binding
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * oauth_access_tokens: issued bearer tokens presented on /mcp. `tokenHash` is
 * sha256(`cf_mcp_...`); `refreshHash` is sha256(`cf_ref_...`) for the paired
 * refresh token (rotated on every refresh). Consumed rows are retained as
 * hashed replay sentinels and linked by `familyId`; a replay revokes every row
 * in that family. Resolves to the same RequestUser + TokenContext as a PAT via
 * `userId` + `roleScope`/`campaignId`, so all
 * effective-role caps apply unchanged. OAuth tokens NEVER carry server-admin
 * power (no adminEnabled column — hardcoded false at resolve time).
 */
export const oauthAccessTokens = sqliteTable('oauth_access_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  refreshHash: text('refresh_hash').unique(),
  // Every rotation keeps the same opaque family id. Consumed generations stay
  // behind as replay sentinels until expiry; no raw token material is retained.
  familyId: text('family_id').notNull(),
  clientId: text('client_id').notNull(),
  userId: integer('user_id').notNull(),
  scope: text('scope'), // granted OAuth scope string
  resource: text('resource'),
  roleScope: text('role_scope').notNull().default('dm'),
  campaignId: integer('campaign_id'),
  expiresAt: text('expires_at').notNull(), // access-token expiry
  refreshExpiresAt: text('refresh_expires_at'), // refresh-token expiry, or null
  refreshConsumedAt: text('refresh_consumed_at'), // set exactly once by refresh CAS
  revokedAt: text('revoked_at'), // this access/refresh pair is no longer usable
  familyRevokedAt: text('family_revoked_at'), // replay revokes every generation
  createdAt: text('created_at').notNull(),
});

export const rulePacks = sqliteTable('rule_packs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  version: text('version').notNull().default(''),
  license: text('license').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  installedAt: text('installed_at').notNull(),
  entryCount: integer('entry_count').notNull().default(0),
});

export const ruleEntries = sqliteTable('rule_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packId: integer('pack_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  summary: text('summary').notNull().default(''),
  body: text('body').notNull().default(''),
  dataJson: text('data_json'),
  // Human-readable source/document label (e.g. Open5e `document.name`) so entries from
  // different rulebooks are distinguishable and attributable (issue #143). Nullable-as-''
  // in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  source: text('source').notNull().default(''),
  // Per-entry provenance (issue #734): a pack may mix licenses, and the reader must credit
  // each entry under its OWN license rather than the pack's. license/attribution/author/
  // sourceUrl capture the entry's effective open-license metadata; '' on rows written
  // before migration 0050 (callers treat '' as "inherit the pack's value"). See
  // migrateRuleEntriesTableForLicensing().
  license: text('license').notNull().default(''),
  attribution: text('attribution').notNull().default(''),
  author: text('author').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  // Optional manual icon override (issue #305): slug of a bundled game-icons.net entity
  // icon, or '' to let the web app derive a default from type/dataJson. Nullable/absent
  // in older DBs pre-migration; see db/db.module.ts migrateRuleEntriesTableForIconSlug().
  iconSlug: text('icon_slug').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const proposals = sqliteTable('proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: integer('entity_id'),
  action: text('action').notNull(),
  payload: text('payload').notNull().default('{}'),
  // JSON snapshot of the target entity at propose time (update proposals only; NULL for
  // creates and for rows written before this column existed) — powers before/after diffs.
  snapshot: text('snapshot'),
  // Human-readable display name of the submitting user (issue #124).
  proposer: text('proposer').notNull(),
  // Stable id of the submitting user (String(users.id) or dev:<name>) — powers the
  // proposer self-view filter. Empty on rows written before this column existed.
  proposerUserId: text('proposer_user_id').notNull().default(''),
  // Token name when submitted via a PAT (secondary provenance), else NULL.
  proposerToken: text('proposer_token'),
  status: text('status').notNull().default('pending'),
  resolvedBy: text('resolved_by').notNull().default(''),
  note: text('note').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Uploaded images (character portraits, campaign maps, misc). File bytes live on disk at
// DATA_DIR/uploads/<campaignId>/<id>.<ext> — this row is metadata only. See modules/attachments.
export const attachments = sqliteTable('attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  uploaderUserId: text('uploader_user_id').notNull(),
  kind: text('kind').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  // Per-attachment visibility / staged reveal (issue #97). hidden=1 => DM-only:
  // the file bytes and the row are withheld from non-DM members until revealed.
  // New map/image uploads default hidden; portraits default visible. Migrated via
  // migrateAttachmentsTableForHidden().
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  // Publication state for the filesystem/SQLite recovery protocol (issue #728).
  // A reserved row counts against quota but is never returned by attachment reads.
  // It becomes committed only after the final file has been renamed into place and
  // both the staged bytes and containing directory have been fsynced. Existing rows
  // are backfilled committed by migrateAttachmentsTableForPublicationState().
  state: text('state').notNull().default('committed'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Combat tracker — see modules/encounters. One encounter belongs to a campaign and
// carries N combatants (party members auto-added on create, monsters/NPCs added by the DM).
export const encounters = sqliteTable('encounters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('preparing'),
  round: integer('round').notNull().default(0),
  turnIndex: integer('turn_index').notNull().default(0),
  // Identity-based turn pointer (issue #49) — the combatant whose turn it is,
  // independent of positional shuffling on add/remove. null when not running/empty.
  currentCombatantId: integer('current_combatant_id'),
  // Optional where/why/when links (issue #126) + battle map (issue #39). Nullable;
  // added by migration on older DBs (see db/db.module.ts).
  locationId: integer('location_id'),
  questId: integer('quest_id'),
  sessionId: integer('session_id'),
  mapAttachmentId: integer('map_attachment_id'),
  // VTT grid + fog (issue #40, phases 2–3). All nullable; added by migration on older DBs
  // (see db/db.module.ts migrateEncountersTableForVtt). gridSize null = no grid drawn; fog
  // is a JSON FogState blob (null = never configured). See @campfire/schema.
  gridSize: real('grid_size'),
  gridScale: real('grid_scale'),
  gridUnit: text('grid_unit'),
  gridSnap: integer('grid_snap', { mode: 'boolean' }).notNull().default(false),
  fog: text('fog'),
  // Grid geometry + shared AoE templates (issue #238). grid_type is 'square'|'hex' (added by
  // migration on older DBs, backfilled 'square'); aoe is a JSON AoeTemplate[] blob (null = []).
  gridType: text('grid_type').notNull().default('square'),
  aoe: text('aoe'),
  // Entity-level secrecy (issue #262) — see quests.hidden. A hidden encounter's roster +
  // difficulty are DM-only, and the encounter is dropped wholesale from non-DM reads until
  // the DM reveals it. Added by migration on older DBs (see db/db.module.ts).
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  endedAt: text('ended_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Shared dice log (issue #35) — see modules/rolls. Every POST /campaigns/:id/roll
// persists a row here so all campaign members share one roll feed. `rolls` is the
// per-die results array stored as JSON text (same convention as characters.conditions).
export const diceRolls = sqliteTable('dice_rolls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  rollerUserId: text('roller_user_id').notNull(),
  rollerName: text('roller_name').notNull().default(''),
  expr: text('expr').notNull(),
  rolls: text('rolls').notNull().default('[]'),
  // JSON array of the kept dice (issue #130) — null when no keep/drop clause applied.
  kept: text('kept'),
  // Per-term breakdown JSON for compound expressions (issue #536) — null for a classic
  // single-term roll. Each entry: {term, value, rolls?, kept?}. Same nullable-JSON
  // convention as `kept`.
  terms: text('terms'),
  total: integer('total').notNull(),
  // Optional check context (issue #130): label + difficulty class. success is derived.
  label: text('label'),
  dc: integer('dc'),
  createdAt: text('created_at').notNull(),
});

// In-app notifications — one row per recipient per event (see modules/notifications).
// Written by domain services (sessions/notes/membership) on the triggering event;
// read/marked-read only by the recipient. `read_at` null = unread.
export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(), // recipient users.id
  campaignId: integer('campaign_id').notNull(),
  type: text('type').notNull(), // NotificationType in @campfire/schema
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  entityType: text('entity_type'),
  entityId: integer('entity_id'),
  commentId: integer('comment_id'), // optional comment focus inside the entity thread (#446)
  actorName: text('actor_name').notNull().default(''),
  readAt: text('read_at'),
  createdAt: text('created_at').notNull(),
});

// Inventory & loot — see modules/inventory. Items belong to the party stash
// (owner_type='party', character_id NULL) or a single character
// (owner_type='character', character_id set).
export const inventoryItems = sqliteTable('inventory_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  ownerType: text('owner_type').notNull().default('party'), // 'party' | 'character'
  characterId: integer('character_id'), // set iff ownerType='character'
  name: text('name').notNull(),
  qty: integer('qty').notNull().default(1),
  notes: text('notes').notNull().default(''),
  iconSlug: text('icon_slug').notNull().default(''), // optional game-icons override (issue #307)
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Issue #782: per-action idempotency for inventory quantity writes. A client-generated
// key records the committed item JSON so a lost-response retry returns the same
// result without re-applying a qtyDelta. Fingerprint binds the key to one operation
// (qty + accompanying mutable fields) — reuse with a different payload is a 409.
// Rows are pruned opportunistically on write once past the TTL window (created_at).
export const inventoryQtyIdempotency = sqliteTable('inventory_qty_idempotency', {
  key: text('key').primaryKey(),
  itemId: integer('item_id').notNull(),
  userId: text('user_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  responseJson: text('response_json').notNull(),
  createdAt: text('created_at').notNull(),
});

// Party treasury — one coin-totals row per campaign, created lazily on first read/write.
export const partyTreasury = sqliteTable('party_treasury', {
  campaignId: integer('campaign_id').primaryKey(),
  cp: integer('cp').notNull().default(0),
  sp: integer('sp').notNull().default(0),
  ep: integer('ep').notNull().default(0),
  gp: integer('gp').notNull().default(0),
  pp: integer('pp').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

// Experimental server-side AI Dungeon Master (issue #28) — one seat per campaign,
// created lazily on first configure/read. Metered against a per-campaign token
// budget; the server never calls an LLM vendor (see modules/ai-dm).
export const aiDmSeats = sqliteTable('ai_dm_seats', {
  campaignId: integer('campaign_id').primaryKey(),
  mode: text('mode').notNull().default('off'), // 'off' | 'co_dm' | 'driver' (issue #311)
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  model: text('model').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  tokenBudget: integer('token_budget').notNull().default(0),
  tokensUsed: integer('tokens_used').notNull().default(0),
  turnCount: integer('turn_count').notNull().default(0),
  lastTurnAt: text('last_turn_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// AI provider config storage (issue #310): provider selection + ENCRYPTED API key
// at two scopes — 'server' (one row, admin default) and 'campaign' (per-campaign
// override, DM-managed, cascades on campaign delete). `encrypted_api_key` holds an
// aes-256-gcm ciphertext (see common/crypto.ts encryptSecret); the plaintext key is
// NEVER stored/returned/logged/exported — reads expose only `key_last4`. Unique
// partial indexes enforce exactly one server row and one row per campaign (see
// db.module.ts bootstrap + migrateAiProviderConfigTable).
export const aiProviderConfigs = sqliteTable('ai_provider_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').notNull(), // 'server' | 'campaign'
  campaignId: integer('campaign_id'), // null for the server default; FK->campaigns ON DELETE CASCADE (fresh DBs)
  providerType: text('provider_type').notNull(), // 'openai' | 'anthropic' | 'mock'
  baseUrl: text('base_url'),
  model: text('model').notNull().default(''),
  params: text('params').notNull().default('{}'), // JSON-encoded AiProviderParams
  encryptedApiKey: text('encrypted_api_key'), // aes-256-gcm ciphertext; null = no key stored
  keyLast4: text('key_last4'), // masked display indicator only — never the key
  allowedModels: text('allowed_models').notNull().default('[]'), // JSON string[] admin allowlist (server scope)
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// AI scribe config + jobs (issue #316). `ai_scribe_configs` holds the per-campaign
// trigger toggles + per-run token cap (all opt-in; the scribe never runs unrequested).
// `ai_scribe_jobs` records every run for idempotency (source_hash dedupe) + an audit
// trail of what was drafted. Both cascade on campaign delete.
export const aiScribeConfigs = sqliteTable('ai_scribe_configs', {
  campaignId: integer('campaign_id').primaryKey(), // FK->campaigns ON DELETE CASCADE (bootstrap/migration)
  postSession: integer('post_session', { mode: 'boolean' }).notNull().default(false),
  cron: integer('cron', { mode: 'boolean' }).notNull().default(false),
  budgetPerRun: integer('budget_per_run').notNull().default(2000),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const aiScribeJobs = sqliteTable('ai_scribe_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE
  trigger: text('trigger').notNull(), // 'on_demand' | 'post_session' | 'cron'
  status: text('status').notNull(), // ScribeJobStatus
  sourceHash: text('source_hash'), // sha256 of assembled source material — idempotency dedupe
  proposalId: integer('proposal_id'), // the filed recap proposal (status=succeeded)
  proposalCount: integer('proposal_count').notNull().default(0),
  tokensUsed: integer('tokens_used').notNull().default(0),
  provider: text('provider').notNull().default(''),
  detail: text('detail').notNull().default(''),
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

export const combatants = sqliteTable('combatants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  encounterId: integer('encounter_id').notNull(),
  kind: text('kind').notNull(), // 'character' | 'monster' | 'npc'
  characterId: integer('character_id'), // set when kind='character' — links back to characters.id
  npcId: integer('npc_id'), // set when kind='npc' — links back to npcs.id (identity). Added by migration on older DBs.
  name: text('name').notNull(),
  initiative: integer('initiative'), // null until rolled
  initMod: integer('init_mod').notNull().default(0),
  hpCurrent: integer('hp_current').notNull().default(10),
  hpMax: integer('hp_max').notNull().default(10),
  // Temp HP + death-save subsystem (issue #57). Added by migration on older DBs;
  // see db/db.module.ts migrateCombatantsTableForHpModel().
  hpTemp: integer('hp_temp').notNull().default(0),
  deathState: text('death_state').notNull().default('none'), // 'none' | 'dying' | 'stable' | 'dead'
  deathSaveSuccesses: integer('death_save_successes').notNull().default(0),
  deathSaveFailures: integer('death_save_failures').notNull().default(0),
  conditions: text('conditions').notNull().default('[]'),
  ruleEntryId: integer('rule_entry_id'), // optional link to compendium rule_entries (monster statblock)
  sortOrder: integer('sort_order').notNull().default(0),
  // Battle-map token position (issue #39) — 0–100 percent overlay on the encounter's
  // map image, mirroring locations.map_x/map_y. Nullable; added by migration on older
  // DBs — see db/db.module.ts migrateCombatantsTableForTokenPosition. null = not placed.
  tokenX: real('token_x'),
  tokenY: real('token_y'),
  // Token footprint size category (issue #40, phase 2). NOT NULL DEFAULT 'medium'; added by
  // migration on older DBs — see db/db.module.ts migrateCombatantsTableForTokenSize.
  tokenSize: text('token_size').notNull().default('medium'),
  // Issue #466: character.updatedAt at the last acknowledged sheet↔combatant HP sync
  // (create/add seed, live mirror, /end write-back, or reopen resync decision). Used as
  // the compare-and-set token so a re-end cannot silently overwrite intervening sheet HP.
  // Nullable for legacy rows; first sync after upgrade stamps it.
  sheetSyncedUpdatedAt: text('sheet_synced_updated_at'),
});

// Persistent per-encounter combat log (issue #61) — see modules/encounters. One row
// per meaningful combat mutation (damage/heal, condition add/remove, death, turn/round),
// written by EncountersService so the run view can show a scrollable history that
// survives reload. actor/target are denormalized combatant NAMES (nullable) so the log
// renders even after a combatant is removed; actor_id/target_id are stable combatant
// ids for role-aware projection (issue #869). `detail` never carries a monster's exact
// HP total (only the delta) and must not embed combatant names that could bypass
// actor/target redaction for hidden NPCs.
// Durable retry queue for upload paths that survived metadata deletion (issue #727).
// No FKs: campaign rows may already be purged while bytes remain on disk.
export const fsDeletionQueue = sqliteTable('fs_deletion_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  relPath: text('rel_path').notNull().unique(),
  kind: text('kind').notNull(), // 'file' | 'directory'
  scope: text('scope').notNull(), // 'attachment' | 'campaign_purge'
  campaignId: integer('campaign_id'),
  entityId: integer('entity_id'),
  status: text('status').notNull().default('pending'), // 'held' | 'pending' | 'failed'
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const encounterEvents = sqliteTable('encounter_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  encounterId: integer('encounter_id').notNull(),
  round: integer('round').notNull().default(0),
  type: text('type').notNull(), // EncounterEventType in @campfire/schema
  actor: text('actor'),
  target: text('target'),
  actorId: integer('actor_id'),
  targetId: integer('target_id'),
  detail: text('detail').notNull().default(''),
  createdAt: text('created_at').notNull(),
});
