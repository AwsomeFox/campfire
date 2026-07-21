import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

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
  // Per-campaign upload quota in bytes, or NULL for no limit (issue #24). Admin-set
  // via the storage console; enforced on attachment upload. Nullable in older DBs
  // pre-migration; see db/db.module.ts ALTER TABLE note.
  storageQuotaBytes: integer('storage_quota_bytes'),
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
// wholesale on write. character_name is denormalized so recaps/cards don't join.
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
  createdBy: text('created_by').notNull().default(''),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
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
  entityType: text('entity_type').notNull(), // 'session' | 'quest' | 'npc' | 'location'
  entityId: integer('entity_id').notNull(),
  snapshot: text('snapshot').notNull().default('{}'), // JSON: { recap } | { body }
  authorUserId: text('author_user_id').notNull().default(''),
  authorName: text('author_name').notNull().default(''),
  createdAt: text('created_at').notNull(),
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
  // Personal text-size preference: 'default' | 'large'. Added by migration on
  // older DBs; see db/db.module.ts ALTER TABLE note.
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

export const campaignMembers = sqliteTable('campaign_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  userId: integer('user_id').notNull(),
  role: text('role').notNull(),
  characterId: integer('character_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// DM invite links / join codes — see modules/membership/invites.service.ts.
// `code` is stored PLAINTEXT, unlike session/PAT tokens (which store sha256):
// an invite code is a shareable capability the DM re-displays and re-copies from
// the UI, and it can only create a NEW membership at a capped role (never dm) —
// it cannot impersonate an existing user. It is 128-bit random, always expiring,
// optionally use-capped, and revocable (row delete).
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
 * refresh token (rotated on every refresh). Resolves to the same RequestUser +
 * TokenContext as a PAT via `userId` + `roleScope`/`campaignId`, so all
 * effective-role caps apply unchanged. OAuth tokens NEVER carry server-admin
 * power (no adminEnabled column — hardcoded false at resolve time).
 */
export const oauthAccessTokens = sqliteTable('oauth_access_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  refreshHash: text('refresh_hash').unique(),
  clientId: text('client_id').notNull(),
  userId: integer('user_id').notNull(),
  scope: text('scope'), // granted OAuth scope string
  resource: text('resource'),
  roleScope: text('role_scope').notNull().default('dm'),
  campaignId: integer('campaign_id'),
  expiresAt: text('expires_at').notNull(), // access-token expiry
  refreshExpiresAt: text('refresh_expires_at'), // refresh-token expiry, or null
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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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

export const combatants = sqliteTable('combatants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  encounterId: integer('encounter_id').notNull(),
  kind: text('kind').notNull(), // 'character' | 'monster'
  characterId: integer('character_id'), // set when kind='character' — links back to characters.id
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
});

// Persistent per-encounter combat log (issue #61) — see modules/encounters. One row
// per meaningful combat mutation (damage/heal, condition add/remove, death, turn/round),
// written by EncountersService so the run view can show a scrollable history that
// survives reload. actor/target are denormalized combatant NAMES (nullable) so the log
// renders even after a combatant is removed; `detail` never carries a monster's exact HP
// total (only the delta), so listing the log to a non-DM can't leak issue #43's redaction.
export const encounterEvents = sqliteTable('encounter_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  encounterId: integer('encounter_id').notNull(),
  round: integer('round').notNull().default(0),
  type: text('type').notNull(), // EncounterEventType in @campfire/schema
  actor: text('actor'),
  target: text('target'),
  detail: text('detail').notNull().default(''),
  createdAt: text('created_at').notNull(),
});
