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

export const npcs = sqliteTable('npcs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull().default(''),
  disposition: text('disposition').notNull().default('neutral'),
  locationId: integer('location_id'),
  body: text('body').notNull().default(''),
  dmSecret: text('dm_secret').notNull().default(''),
  // Entity-level secrecy (issue #42) — see quests.hidden. Migrated via
  // migrateNpcsTableForHidden() in db/db.module.ts.
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const locations = sqliteTable('locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default(''),
  status: text('status').notNull().default('unexplored'),
  mapX: real('map_x'),
  mapY: real('map_y'),
  body: text('body').notNull().default(''),
  dmSecret: text('dm_secret').notNull().default(''),
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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
  body: text('body').notNull(),
  resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
  resolvedNote: text('resolved_note').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
  proposer: text('proposer').notNull(),
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
  total: integer('total').notNull(),
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
  conditions: text('conditions').notNull().default('[]'),
  ruleEntryId: integer('rule_entry_id'), // optional link to compendium rule_entries (monster statblock)
  sortOrder: integer('sort_order').notNull().default(0),
});
