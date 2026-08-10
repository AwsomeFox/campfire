import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import type { AiDmComprehensionProfile, AiDmProactiveSettings, AiDmStylePresets } from '@campfire/schema';

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
  // Issue #871: campaign-wide narrative tone/challenge backdrop — see the full object/timeframe/
  // audience/owner/consequence definition on `DangerLevel` in @campfire/schema. No column rename:
  // the wire format is unchanged, only the user-facing label and contextual help were clarified.
  dangerLevel: text('danger_level').notNull().default('low'),
  // When true, only the DM may award XP / level up characters (issue #270). Added in
  // older DBs via migrateCampaignsTableForDmControlsProgression() — see db/db.module.ts.
  dmControlsProgression: integer('dm_controls_progression', { mode: 'boolean' }).notNull().default(false),
  // Issue #413: turn-advancement controls. dmControlsTurns keeps advancement DM-only;
  // requireDmTurnConfirmation stages a player end-turn for DM approval. Added by migration
  // on older DBs — see db/db.module.ts migrateCampaignsTableForTurnControls().
  dmControlsTurns: integer('dm_controls_turns', { mode: 'boolean' }).notNull().default(false),
  requireDmTurnConfirmation: integer('require_dm_turn_confirmation', { mode: 'boolean' }).notNull().default(false),
  publicRecapSharingEnabled: integer('public_recap_sharing_enabled', { mode: 'boolean' }).notNull().default(true),
  // Issue #857: when false, public invite preview/accept/join all 404 with the
  // uniform inactive message. Archive/trash auto-clears this; restore/unarchive
  // does NOT flip it back — deliberate reactivation via the invites policy
  // endpoint is required. Nullable in older DBs pre-migration; see db.module.ts.
  publicInvitesEnabled: integer('public_invites_enabled', { mode: 'boolean' }).notNull().default(true),
  // Issue #635: AI narration output language (Driver / co-DM / Scribe). Distinct from
  // the client UI locale. Nullable in older DBs pre-migration; see db.module.ts.
  narrationLanguage: text('narration_language').notNull().default('en'),
  // Issue #501: campaign-level policy for member-authored material leaving the server
  // for external AI generation. Paired with campaignMembers.aiExternalUseConsent.
  aiExternalContentPolicy: text('ai_external_content_policy').notNull().default('member_consent'),
  sessionCount: integer('session_count').notNull().default(0),
  // Issue #841: highest canonical session number (MAX of live session numbers), not the recap count.
  latestSessionNumber: integer('latest_session_number').notNull().default(0),
  // Slug of the installed rule pack (see rulePacks.slug) powering this campaign, or '' if unset.
  // Nullable in older DBs pre-migration; see db/db.module.ts ALTER TABLE note.
  ruleSystem: text('rule_system').notNull().default(''),
  // JSON string[] of additional content-only rule-pack slugs enabled for this
  // campaign. Kept separate from ruleSystem so supplements never affect adapters.
  enabledPackSlugs: text('enabled_pack_slugs').notNull().default('[]'),
  // Issue #1502: a per-campaign homebrew mechanics profile (JSON-encoded HomebrewMechanicsProfile
  // from @campfire/schema), or NULL when unset. Only meaningful alongside a `ruleSystem` slug
  // that is NOT a built-in registered adapter — enforced in CampaignsService, not here. NULL in
  // every campaign that predates this column; see db/db.module.ts ALTER TABLE note.
  customMechanicsProfile: text('custom_mechanics_profile'),
  // Issue #1505: JSON campaign-owned condition templates. A definition is not an
  // applied condition; it supplies the member-visible vocabulary and picker defaults.
  conditionDefinitions: text('condition_definitions').notNull().default('[]'),
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
  // Issue #587: this campaign's opt-out from disclosing its NAME and DESCRIPTION in
  // the server-admin metadata catalog. 'inherit' (default) follows the server-wide
  // policy; 'redacted' overrides it toward privacy. Tighten-only, and writable ONLY
  // by the campaign's own DM (PUT /campaigns/:id/catalog-privacy) — deliberately not
  // reachable from any admin bulk operation, because an opt-out a server admin can
  // clear is not an opt-out. Nullable in older DBs pre-migration; see
  // db/db.module.ts migrateAdminCampaignCatalog587().
  catalogPrivacy: text('catalog_privacy').notNull().default('inherit'),
  // Soft-delete / trash timestamp (issue #116). NULL => live; an ISO timestamp => the
  // campaign is trashed: excluded from normal listings while its rows + on-disk uploads
  // survive for a grace period, restorable until an explicit purge. Migrated via
  // migrateSoftDeleteColumns() in db/db.module.ts.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Append-only lifecycle-status transition provenance for a campaign (issue #846).
 * Every status change (active<->paused<->completed) inserts a row, so reactivation
 * (back to active) and re-archiving keep the full history; the newest row is the
 * current provenance surfaced in the archived banner and settings.
 *
 * `actorUserId` is the durable install-local id; `actorName` is a display-name
 * snapshot captured at transition time (a later rename does not rewrite history).
 * `reason` is DM operational text and is NOT shown to players. Cascades with the
 * campaign so a purge cleans its provenance too.
 */
export const campaignStatusTransitions = sqliteTable(
  'campaign_status_transitions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    actorName: text('actor_name').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    reason: text('reason').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    campaignTransitionsIdx: index('idx_campaign_status_transitions_campaign').on(t.campaignId, t.createdAt),
  }),
);

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
  eac: integer('eac'),
  kac: integer('kac'),
  // Issue #1910: movement speed. Nullable — see @campfire/schema's Character.speed doc.
  speed: integer('speed'),
  hpCurrent: integer('hp_current').notNull().default(10),
  hpMax: integer('hp_max').notNull().default(10),
  spCurrent: integer('sp_current').notNull().default(0),
  spMax: integer('sp_max').notNull().default(0),
  rpCurrent: integer('rp_current').notNull().default(0),
  rpMax: integer('rp_max').notNull().default(0),
  // Issue #711: the combat death/temp-HP subsystem (issue #57) mirrored back
  // from the encounter at /end. `hpTemp` is the carried-over temp-HP pool; the
  // three death-save fields echo the combatant lifecycle so a dead PC stays
  // visibly dead on the sheet and is skipped by the next encounter's auto-add.
  hpTemp: integer('hp_temp').notNull().default(0),
  deathState: text('death_state').notNull().default('none'),
  deathSaveSuccesses: integer('death_save_successes').notNull().default(0),
  deathSaveFailures: integer('death_save_failures').notNull().default(0),
  conditions: text('conditions').notNull().default('[]'),
  // Issue #1047: structured condition instances as a JSON ConditionInstance[] blob, the
  // sheet-scoped counterpart to combatants.condition_instances. Nullable; added by
  // migration 0132 on older DBs. NULL = derive from the legacy `conditions` names
  // (common/conditions.ts readConditionInstances), which is what keeps years of bare
  // strings readable without a rewrite. Round/turn-scoped fields are always null here —
  // see toSheetConditionInstance for why.
  conditionInstances: text('condition_instances'),
  saveProficiencies: text('save_proficiencies').notNull().default('[]'),
  skills: text('skills').notNull().default('{}'),
  actions: text('actions').notNull().default('[]'),
  spellSlots: text('spell_slots').notNull().default('{}'),
  resources: text('resources').notNull().default('{}'),
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
  // Soft-delete / trash timestamp (issue #701) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
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
  // Soft-delete / trash timestamp (issue #701) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
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
  // Soft-delete / trash timestamp (issue #116 / #693).
  deletedAt: text('deleted_at'),
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
  // Issue #600: how much of the PUBLISHED charter a not-yet-member sees at an invite link.
  // 'boundaries' (default) | 'full'. Absent in older DBs pre-migration; see
  // db/db.module.ts migrateSessionZeroConsent600().
  previewPolicy: text('preview_policy').notNull().default('boundaries'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Issue #600: immutable published charter versions.
 *
 * `session_zero` above is the DM's mutable WORKING DRAFT. Publishing snapshots it here,
 * and rows in this table are never updated afterwards — the service has no update path
 * for them. That immutability is the feature, not an implementation detail: an
 * acknowledgment points at one `id`, so "what did they actually agree to" stays
 * answerable after the DM has revised the charter five more times.
 */
export const sessionZeroCharterVersions = sqliteTable(
  'session_zero_charter_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    /** 1-based per campaign, gapless. */
    version: integer('version').notNull(),
    lines: text('lines').notNull().default('[]'),
    veils: text('veils').notNull().default('[]'),
    safetyTools: text('safety_tools').notNull().default('[]'),
    houseRules: text('house_rules').notNull().default(''),
    toneAndExpectations: text('tone_and_expectations').notNull().default(''),
    /** Whether this version WITHDREW a protection vs its predecessor. Frozen at publish. */
    material: integer('material', { mode: 'boolean' }).notNull().default(false),
    changeSummary: text('change_summary').notNull().default(''),
    publishedBy: text('published_by').notNull().default(''),
    publishedAt: text('published_at').notNull(),
  },
  (t) => ({
    campaignVersionUnique: uniqueIndex('idx_charter_versions_campaign_version').on(t.campaignId, t.version),
    campaignIdx: index('idx_charter_versions_campaign').on(t.campaignId, t.version),
  }),
);

/** Issue #600: one participant's answer to ONE immutable version. */
export const sessionZeroAcknowledgments = sqliteTable(
  'session_zero_acknowledgments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    versionId: integer('version_id').notNull(),
    userId: text('user_id').notNull(),
    userName: text('user_name').notNull().default(''),
    /** 'acknowledged' | 'discuss' | 'declined'. Only the first clears the consent gate. */
    state: text('state').notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    versionUserUnique: uniqueIndex('idx_charter_acks_version_user').on(t.versionId, t.userId),
    versionIdx: index('idx_charter_acks_version').on(t.versionId),
  }),
);

/**
 * Issue #600: a boundary sent privately to the facilitator.
 *
 * Never readable by other participants, never exported, never sent to a model. When
 * `anonymous`, every facilitator-facing read path drops the submitter columns rather
 * than merely declining to render them.
 */
export const sessionZeroBoundarySubmissions = sqliteTable(
  'session_zero_boundary_submissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    anonymous: integer('anonymous', { mode: 'boolean' }).notNull().default(false),
    /** Retained even when anonymous, solely so the submitter can withdraw their own row. */
    submitterUserId: text('submitter_user_id').notNull(),
    submitterName: text('submitter_name').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ campaignIdx: index('idx_charter_boundary_campaign').on(t.campaignId, t.id) }),
);

/**
 * Issue #600: guardian consent, carrying NO date of birth.
 *
 * There is no birth date, age, or birth year column here, and there must never be one.
 * `minorAttested` is an assertion, not a measurement — the point of the requirement is
 * that the identifier is never collected, and a column that stored a date in order to
 * compute this boolean would have already done the harm.
 */
export const sessionZeroGuardianConsents = sqliteTable(
  'session_zero_guardian_consents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    userId: text('user_id').notNull(),
    userName: text('user_name').notNull().default(''),
    versionId: integer('version_id').notNull(),
    guardianName: text('guardian_name').notNull().default(''),
    guardianEmail: text('guardian_email').notNull().default(''),
    guardianRelationship: text('guardian_relationship').notNull().default(''),
    minorAttested: integer('minor_attested', { mode: 'boolean' }).notNull().default(true),
    status: text('status').notNull().default('pending'),
    decisionNote: text('decision_note').notNull().default(''),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    campaignUserUnique: uniqueIndex('idx_charter_guardian_campaign_user').on(t.campaignId, t.userId),
    campaignIdx: index('idx_charter_guardian_campaign').on(t.campaignId, t.status),
  }),
);

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
  portraitUrl: text('portrait_url'),
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
  // Emblem/banner portrait image (issue #1324). Resolved attachment URL; nullable.
  portraitUrl: text('portrait_url'),
  // Soft-delete / trash timestamp (issue #701) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
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
  // Landmark/portrait image (issue #1324). Resolved attachment URL; nullable.
  portraitUrl: text('portrait_url'),
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
  // Optional durable link back to the planned schedule row this recap/play log completed (#504).
  // Nullable in older DBs pre-migration; see db/db.module.ts migrateSchedulingLifecycle504().
  scheduledSessionId: integer('scheduled_session_id'),
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
  createdByUserId: text('created_by_user_id'),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  expiresAt: text('expires_at'),
  accessCount: integer('access_count').notNull().default(0),
  firstAccessedAt: text('first_accessed_at'),
  lastAccessedAt: text('last_accessed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Expiring read-only Player Display cast sessions (issue #547).
// Raw cast tokens and exit PINs are shown once; the DB stores only sha256 hashes.
export const castSessions = sqliteTable('cast_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  label: text('label').notNull().default(''),
  createdBy: text('created_by').notNull().default(''),
  createdByUserId: text('created_by_user_id'),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  exitPinHash: text('exit_pin_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  accessCount: integer('access_count').notNull().default(0),
  firstAccessedAt: text('first_accessed_at'),
  lastAccessedAt: text('last_accessed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Organized play (issue #588): a venue is an install-level resource, not a
// campaign child — several campaigns share one room calendar by design, so a
// venue cannot hang off a single campaign (and a campaign purge must not take
// the room with it).
//
// WHERE THE CONSTRAINTS LIVE, before anyone files "these tables declare no
// foreign keys and no unique indexes": this file is the drizzle QUERY-side view,
// not the DDL. Schema is hand-written in bootstrap.sql.ts — only 6 of ~80 tables
// here bother with `references()`, and those are for relation typing rather than
// for creating the constraint. The organized-play tables are fully constrained
// there: `play_rooms.venue_id` → `play_venues` ON DELETE CASCADE plus
// `UNIQUE(venue_id, name)`; `session_series.campaign_id` → `campaigns` CASCADE,
// with `venue_id`/`room_id` ON DELETE SET NULL; `series_exceptions.series_id` →
// `session_series` CASCADE and `occurrence_id` SET NULL;
// `schedule_templates.venue_id` and `scheduled_sessions.series_id` SET NULL; and
// `idx_session_series_uid` is a UNIQUE index on `series_uid`, which is what stops
// two series minting colliding ICS UIDs. Adding `references()` here would change
// no database — and the application-level cascade in CampaignsService.purge()
// exists because installs predating FK enforcement still have to purge cleanly,
// which is what db-cascades.e2e-spec.ts pins on both paths.
export const playVenues = sqliteTable('play_venues', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // IANA zone — the default zone for series booked here.
  timezone: text('timezone').notNull().default('UTC'),
  address: text('address').notNull().default(''),
  notes: text('notes').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// One bookable table/room inside a venue. capacity 0 = unlimited.
export const playRooms = sqliteTable('play_rooms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  venueId: integer('venue_id').notNull(),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull().default(0),
  notes: text('notes').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// A recurring run of game nights (issue #588). Stores the IANA zone plus the LOCAL
// start date/time and the rule — never a first instant plus a fixed stride — so
// occurrences materialize at the same wall clock on both sides of a DST
// transition. See db/db.module.ts migrateOrganizedPlay588().
export const sessionSeries = sqliteTable('session_series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  title: text('title').notNull().default(''),
  location: text('location').notNull().default(''),
  notes: text('notes').notNull().default(''),
  timezone: text('timezone').notNull().default('UTC'),
  startDate: text('start_date').notNull(), // YYYY-MM-DD, local to `timezone`
  startTime: text('start_time').notNull(), // HH:MM, local to `timezone`
  durationMinutes: integer('duration_minutes').notNull().default(240),
  freq: text('freq').notNull().default('weekly'),
  interval: integer('interval').notNull().default(1),
  count: integer('count').notNull().default(1),
  untilDate: text('until_date'),
  venueId: integer('venue_id'),
  roomId: integer('room_id'),
  assignedDmUserId: text('assigned_dm_user_id').notNull().default(''),
  capacity: integer('capacity').notNull().default(0),
  eventId: text('event_id').notNull().default(''),
  seasonId: text('season_id').notNull().default(''),
  seriesUid: text('series_uid').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Append-only per-occurrence deviation ledger: cancellations, reschedules (both
// instants recorded, so lineage is stored rather than inferred from the surviving
// row) and room/DM reassignments.
export const seriesExceptions = sqliteTable('series_exceptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  seriesId: integer('series_id').notNull(),
  occurrenceId: integer('occurrence_id'),
  // The occurrence's ORIGINAL local date — the RFC 5545 RECURRENCE-ID analogue.
  recurrenceLocalDate: text('recurrence_local_date').notNull().default(''),
  kind: text('kind').notNull(), // 'cancel' | 'reschedule' | 'reassign' | 'restore'
  fromScheduledAt: text('from_scheduled_at'),
  toScheduledAt: text('to_scheduled_at'),
  toLocalStart: text('to_local_start').notNull().default(''),
  // #588: the assignment delta, so the append-only lineage can answer "what did
  // this entry change?" rather than only "when".
  fromRoomId: integer('from_room_id'),
  toRoomId: integer('to_room_id'),
  fromAssignedDmUserId: text('from_assigned_dm_user_id').notNull().default(''),
  toAssignedDmUserId: text('to_assigned_dm_user_id').notNull().default(''),
  fromCapacity: integer('from_capacity').notNull().default(0),
  toCapacity: integer('to_capacity').notNull().default(0),
  reason: text('reason').notNull().default(''),
  actorUserId: text('actor_user_id').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

// Reusable blueprint for bulk-creating a block of organized-play tables.
// slots_json is a JSON array of ScheduleTemplateSlot (packages/schema).
export const scheduleTemplates = sqliteTable('schedule_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  venueId: integer('venue_id'),
  timezone: text('timezone').notNull().default('UTC'),
  freq: text('freq').notNull().default('weekly'),
  interval: integer('interval').notNull().default(1),
  count: integer('count').notNull().default(8),
  eventId: text('event_id').notNull().default(''),
  seasonId: text('season_id').notNull().default(''),
  slotsJson: text('slots_json').notNull().default('[]'),
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
  prepNotes: text('prep_notes').notNull().default(''),
  status: text('status').notNull().default('scheduled'),
  cancelledAt: text('cancelled_at'),
  cancelledBy: text('cancelled_by'),
  cancellationReason: text('cancellation_reason').notNull().default(''),
  sessionId: integer('session_id'),
  // Organized-play decoration (issue #588). An occurrence IS a scheduled session:
  // decorating the existing row keeps RSVPs, reminders, the ICS feed and the
  // schedule↔recap link working unchanged, and every column below defaults to
  // empty/absent so a campaign that never opts in sees zero behaviour change.
  // Absent in older DBs pre-migration; see db.module.ts migrateOrganizedPlay588().
  seriesId: integer('series_id'),
  occurrenceIndex: integer('occurrence_index').notNull().default(0),
  timezone: text('timezone').notNull().default(''), // IANA zone, '' = legacy row
  localStart: text('local_start').notNull().default(''), // YYYY-MM-DDTHH:MM in `timezone`
  venueId: integer('venue_id'),
  roomId: integer('room_id'),
  assignedDmUserId: text('assigned_dm_user_id').notNull().default(''),
  capacity: integer('capacity').notNull().default(0), // 0 = unlimited
  eventId: text('event_id').notNull().default(''),
  seasonId: text('season_id').notNull().default(''),
  // Stable RFC 5545 UID + SEQUENCE, so a reschedule rewrites the event in a
  // subscribed calendar instead of leaving a ghost beside a new one. '' on
  // pre-#588 rows until migration 0124 backfills the legacy UID string.
  icsUid: text('ics_uid').notNull().default(''),
  icsSequence: integer('ics_sequence').notNull().default(0),
  originalScheduledAt: text('original_scheduled_at'),
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
  // Imported RSVP ownership uses a reserved per-row proxy, never a local account;
  // preserve its source name on account relabeling.
  userImported: integer('user_imported', { mode: 'boolean' }).notNull().default(false),
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
  // Imported ownership is a local proxy; the copied name remains source provenance.
  authorImported: integer('author_imported', { mode: 'boolean' }).notNull().default(false),
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
  // Moderation quarantine (issue #601). The gap the issue names is that "DMs cannot
  // quarantine whispers": a whisper is invisible to everyone but its author, its single
  // recipient and the DMs, so an abusive one had no removal path short of asking the
  // author to delete their own message. A quarantined note is treated exactly like a
  // trashed one by every NORMAL read (list/get/search) — including for its author and
  // recipient, because withholding it from the target is the point. It stays visible
  // ONLY through the moderation evidence path. Cleared by `unquarantine`.
  quarantinedAt: text('quarantined_at'),
  quarantinedBy: text('quarantined_by'),
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
  // Imported ownership is a local proxy; the copied name remains source provenance.
  authorImported: integer('author_imported', { mode: 'boolean' }).notNull().default(false),
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
  // Moderation quarantine (issue #601). NULL = normal. An ISO timestamp means a DM
  // withheld the body pending review of an open report: toDomain() swaps the prose for
  // a neutral placeholder for EVERY reader (the author included), and the campaign
  // search index drops the row. Unlike deleted_at this is never author-settable — only
  // the moderation queue sets or clears it, and the original prose survives ONLY in the
  // separately-gated moderation_evidence snapshot, never in this row.
  quarantinedAt: text('quarantined_at'),
  quarantinedBy: text('quarantined_by'),
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
  authorImported: integer('author_imported', { mode: 'boolean' }).notNull().default(false),
  authorSource: text('author_source').notNull().default('human'), // 'human' | 'ai' | 'tool'
  authorSourceDetail: text('author_source_detail').notNull().default(''),
  createdAt: text('created_at').notNull().default(''), // authored-at; '' when unknown (legacy)
  // Replacing actor/time — null replaced_at marks the current tip (still live).
  replacedByUserId: text('replaced_by_user_id').notNull().default(''),
  replacedByName: text('replaced_by_name').notNull().default(''),
  replacedByImported: integer('replaced_by_imported', { mode: 'boolean' }).notNull().default(false),
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
  // Versioned, structured audit payload. Null preserves legacy rows unchanged.
  payloadJson: text('payload_json'),
  requestId: text('request_id'),
  createdAt: text('created_at').notNull(),
});

/** One durable plan/apply/undo record for a party recovery (issue #759). */
export const partyRestBatches = sqliteTable('party_rest_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').notNull(),
  previewToken: text('preview_token').notNull().unique(),
  requestFingerprint: text('request_fingerprint').notNull(),
  status: text('status').notNull().default('previewed'), // previewed | applied | undone
  idempotencyKey: text('idempotency_key'),
  undoIdempotencyKey: text('undo_idempotency_key'),
  undoResultJson: text('undo_result_json').notNull().default('{}'),
  beforeJson: text('before_json').notNull().default('{}'),
  planJson: text('plan_json').notNull().default('{}'),
  afterJson: text('after_json').notNull().default('{}'),
  resultJson: text('result_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  appliedAt: text('applied_at'),
  undoneAt: text('undone_at'),
}, (t) => ({ campaignCreatedIdx: index('idx_party_rest_batches_campaign').on(t.campaignId, t.createdAt), actorKeyUnique: uniqueIndex('idx_party_rest_batches_actor_key').on(t.campaignId, t.actorUserId, t.idempotencyKey) }));

// ---------------------------------------------------------------------------
// Moderation / abuse incidents (issue #601)
//
// CASCADE DECISION (deliberate, and the opposite of every other campaign-scoped
// table here): `campaign_id` on the three moderation tables is a PLAIN INTEGER
// with NO `REFERENCES campaigns(id) ON DELETE CASCADE`.
//
// Every other campaign-scoped table cascades because its rows are campaign
// CONTENT — when the campaign is purged, the content should go with it. Abuse
// evidence is not content; it is the record of someone being harmed inside that
// campaign. Cascading would hand any DM a one-click evidence shredder: delete
// the campaign, and every report filed against you evaporates along with the
// snapshots that proved it. That is precisely the failure mode #601 exists to
// close, and it is worse than the equivalent for audit rows because a report is
// often the only remaining copy of content the abuser has already edited away.
//
// So evidence outlives its campaign. The cost is that a purge leaves rows whose
// `campaign_id` no longer resolves — accepted, and bounded three ways:
//   1. Retention is TIME-based (`expires_at`), not lifetime-based: content is
//      redacted on schedule whether or not the campaign still exists (bullet 6,
//      "suitable for minors"). Orphaned rows therefore stop holding prose.
//   2. Orphaned reports are unreachable through the campaign DM queue (there is
//      no campaign left to be a DM of), so they are visible only via audited
//      server-admin break-glass. Fail closed by construction.
//   3. `campaign_purge_tombstones` already establishes the precedent in this DB
//      that some records deliberately survive a purge.
// ---------------------------------------------------------------------------

/**
 * Integrity-protected snapshot of reportable content, captured BEFORE the source
 * row is mutated (or at report time, whichever comes first).
 *
 * `content_hash` is a sha256 over a canonical field serialization — see
 * moderation/moderation-evidence.ts `moderationEvidenceHash` for the exact byte
 * layout and the reasoning behind each included field. Reads recompute it and
 * report intact / redacted / tampered; nothing in the app ever rewrites a stored
 * hash except a recorded redaction, which stamps `redacted_at` so the resulting
 * mismatch is explained rather than alarming.
 */
export const moderationEvidence = sqliteTable('moderation_evidence', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // NOT an FK — see the cascade note above.
  targetType: text('target_type').notNull(), // ModerationTargetType
  targetId: integer('target_id'), // null for 'conduct' (and optional for 'ai_narration')
  reason: text('reason').notNull(), // ModerationEvidenceReason — why the snapshot was taken
  source: text('source').notNull().default('server_capture'), // 'server_capture' | 'reporter_supplied'
  authorUserId: text('author_user_id').notNull().default(''), // the report SUBJECT
  authorName: text('author_name').notNull().default(''),
  recipientUserId: text('recipient_user_id'), // whisper/notification target
  anchorEntityType: text('anchor_entity_type'),
  anchorEntityId: integer('anchor_entity_id'),
  // The source row's own updated_at at capture time — the "revision" #601 asks for.
  revisionAt: text('revision_at').notNull().default(''),
  content: text('content').notNull().default(''),
  contextJson: text('context_json').notNull().default('{}'), // JSON: visibility, inCharacter, parentId, …
  contentHash: text('content_hash').notNull(),
  // sha256 over every field EXCEPT `content`. Redaction overwrites the content, so
  // `content_hash` cannot match afterwards — without this second digest, stamping
  // `redacted_at` would silently switch tamper detection off for the whole row and
  // let the author, target or capture time be rewritten under the benign `redacted`
  // verdict. This digest still verifies after a redaction, so `redacted` means "the
  // content went and nothing else did". See moderation/moderation-evidence.ts.
  metadataHash: text('metadata_hash').notNull().default(''),
  redactedAt: text('redacted_at'),
  redactedBy: text('redacted_by'),
  redactionReason: text('redaction_reason').notNull().default(''),
  expiresAt: text('expires_at'), // content-retention horizon; null = policy disabled at capture
  capturedAt: text('captured_at').notNull(),
});

/**
 * The durable incident record. `subject_user_id` is denormalized off the evidence
 * so the conflicted-DM check (a DM may not moderate a report about themselves)
 * is a column comparison and can never be skipped by a forgotten join.
 */
export const moderationReports = sqliteTable('moderation_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // NOT an FK — see the cascade note above.
  targetType: text('target_type').notNull(),
  targetId: integer('target_id'),
  reporterUserId: text('reporter_user_id').notNull(),
  reporterName: text('reporter_name').notNull().default(''),
  subjectUserId: text('subject_user_id').notNull().default(''),
  subjectName: text('subject_name').notNull().default(''),
  reason: text('reason').notNull(), // ModerationReportReason
  details: text('details').notNull().default(''),
  status: text('status').notNull().default('open'), // ModerationReportStatus
  resolution: text('resolution'), // ModerationResolution; null until resolved
  resolutionNote: text('resolution_note').notNull().default(''),
  evidenceId: integer('evidence_id').notNull(),
  // Whether THIS report is currently withholding its target. Tracked per-report so
  // resolving one report cannot lift a quarantine another still justifies.
  quarantined: integer('quarantined', { mode: 'boolean' }).notNull().default(false),
  escalatedAt: text('escalated_at'),
  escalationReason: text('escalation_reason').notNull().default(''),
  acknowledgedAt: text('acknowledged_at'),
  resolvedAt: text('resolved_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * An active posting mute (the `mute` queue action). Enforced at comment/note
 * creation. Deliberately keyed on the user id rather than a membership row so a
 * muted member who leaves and rejoins is still muted — leaving a table is not a
 * way to clear a moderation sanction.
 */
export const moderationMutes = sqliteTable('moderation_mutes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // NOT an FK — see the cascade note above.
  userId: text('user_id').notNull(), // String(users.id) or dev:<name>
  userName: text('user_name').notNull().default(''),
  reason: text('reason').notNull().default(''),
  expiresAt: text('expires_at'), // null = indefinite, until a DM lifts it
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  // Set when a DM lifts the mute. Kept (rather than deleted) so the sanction
  // history survives — "was this person ever muted here" is a moderation question.
  liftedAt: text('lifted_at'),
  liftedBy: text('lifted_by'),
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
  // Clock rendering preference: 'system' | '12h' | '24h' (issue #634).
  timeFormat: text('time_format').notNull().default('system'),
  // Per-player dice overlay skin (issue #1315).
  diceTheme: text('dice_theme').notNull().default('nocturne'),
  // Whether to play spectator tumble/crit animations for other players' rolls (issue #1899).
  animateOthersRolls: integer('animate_others_rolls', { mode: 'boolean' }).notNull().default(true),
  // Issue #851 — "approved organizer" eligibility under the 'approved_organizers'
  // campaign-creation policy (settings.campaignCreationPolicy). Ignored entirely under
  // the 'everyone'/'admins_only' policies.
  canCreateCampaigns: integer('can_create_campaigns', { mode: 'boolean' }).notNull().default(false),
  // Color-vision-assist mode: adds non-color channels to combat indicators (issue #1942).
  colorVisionAssist: integer('color_vision_assist', { mode: 'boolean' }).notNull().default(false),
  // Table audio & haptics level: 'off' | 'low' | 'medium' | 'high' — synthesized dice/turn
  // cues and vibration, default off (issue #1920).
  tableAudio: text('table_audio').notNull().default('off'),
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

// Issue #851 — the safe request/approval flow for a restricted campaign-creation
// policy. Mirrors passwordResetRequests above: a user files a 'pending' row, an
// admin approves or denies it (approving flips users.canCreateCampaigns to true).
export const campaignCreationRequests = sqliteTable('campaign_creation_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied'
  note: text('note').notNull().default(''),
  requestedAt: text('requested_at').notNull(),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'), // audit actor string (auditActor()), null until decided
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

/** Bootstrap-only diagnostics state; never carries application data. */
export const healthIntegrityResults = sqliteTable('health_integrity_results', {
  kind: text('kind').primaryKey(),
  status: text('status').notNull(),
  code: text('code').notNull(),
  checkedAt: text('checked_at').notNull(),
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
  // Issue #501: member-owned consent for including their authored source material
  // in prompts sent to external AI providers. Defaults false on upgraded DBs.
  aiExternalUseConsent: integer('ai_external_use_consent', { mode: 'boolean' }).notNull().default(false),
  // Issue #545: protected campaign owner/creator marker. This is a seat-level
  // invariant, not a role; temporary guest DMs and ordinary co-DMs cannot remove
  // or demote it.
  primaryOwner: integer('is_primary_owner', { mode: 'boolean' }).notNull().default(false),
  // Issue #597: the explicit "interactive guest" capability. Only consulted on a
  // viewer seat; a viewer without it may not comment, share/whisper notes, or post to
  // the DM inbox. Defaults FALSE so every NEW viewer is read-only, which is what the
  // role has always claimed to be. Existing viewers who had already been taking part
  // are grandfathered to TRUE by migration 0127 — see migrateSafetyControls597.
  interactiveGuest: integer('interactive_guest', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Issue #597 — personal, member-owned safety controls: `block`, `mute_sender`,
 * `mute_thread` (SafetyControlKind in @campfire/schema).
 *
 * Deliberately NOT the same table as moderation_mutes (#601). That one is a moderator
 * SANCTION against a member and is DM-visible; this one is the protected member's own
 * setting and must never be disclosed to its subject — different owner, different
 * audience, different lifecycle. Conflating them would make a personal block
 * discoverable from the DM's mute list, which is exactly the disclosure #597 forbids.
 *
 * Ids are stored as TEXT to match the note-identity convention (`String(users.id)`, or
 * `dev:<name>` under DEV_AUTH) already used by notes.author_user_id,
 * notes.recipient_user_id, and moderation_mutes.user_id. No FK, for the same reason the
 * moderation tables have none: a safety control must survive the account row it names.
 *
 * `campaign_id` is NULL for an account-wide control — every `block` is account-wide,
 * because a block is a statement about a PERSON rather than about one table. Enforcement
 * therefore always matches `campaign_id IS NULL OR campaign_id = ?`.
 */
export const memberSafetyControls = sqliteTable('member_safety_controls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id'),
  kind: text('kind').notNull(), // 'block' | 'mute_sender' | 'mute_thread'
  ownerUserId: text('owner_user_id').notNull(),
  targetUserId: text('target_user_id'),
  threadEntityType: text('thread_entity_type'),
  threadEntityId: integer('thread_entity_id'),
  reason: text('reason').notNull().default(''),
  createdAt: text('created_at').notNull(),
  liftedAt: text('lifted_at'),
});

// Issue #545: time-bounded guest/co-DM authority. `scopes` is a JSON string[]
// using GuestDmGrantScope from @campfire/schema; active grants elevate a member
// to DM only while unrevoked, unhanded-back and within [startsAt, expiresAt).
export const campaignGuestDmGrants = sqliteTable('campaign_guest_dm_grants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  granteeUserId: integer('grantee_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  grantedByUserId: integer('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  scopes: text('scopes').notNull().default('["dm"]'),
  startsAt: text('starts_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  handedBackAt: text('handed_back_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Issue #549 — per-user, per-campaign catch-up cursor independent of auth sessions.
// `lastCaughtUpAt` is bumped when the member marks caught up on the dashboard.
export const campaignCatchUpCursors = sqliteTable(
  'campaign_catch_up_cursors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    lastCaughtUpAt: text('last_caught_up_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    userCampaign: uniqueIndex('idx_campaign_catch_up_user_campaign').on(t.userId, t.campaignId),
  }),
);

// Issue #840 — personal navigation: a user's private bookmarks and bounded recent
// history. Both are per-user, per-campaign polymorphic soft references into the
// supported canon entity set. The FK user_id ON DELETE CASCADE tears them down with
// the account (no orphaned private data on deletion) and campaign_id ON DELETE
// CASCADE tears them down with the campaign. entityType/entityId is a soft
// reference like entity_revisions: visibility is re-resolved at READ time from the
// owning entity services' role-filtered lists, so a row whose target is hidden,
// deleted, or no longer accessible (lost membership / cross-campaign) is simply
// omitted from responses — never returned, never revealing the target's existence.
export const userBookmarks = sqliteTable(
  'user_bookmarks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    // One bookmark per (user, campaign, target) — adding the same target twice is a no-op.
    userTarget: uniqueIndex('idx_user_bookmarks_user_target').on(t.userId, t.campaignId, t.entityType, t.entityId),
    user: index('idx_user_bookmarks_user').on(t.userId),
  }),
);

export const userRecentViews = sqliteTable(
  'user_recent_views',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id').notNull(),
    // Server-stamped instant of the latest visit (bumped on each re-visit).
    visitedAt: text('visited_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    // One row per (user, campaign, target): a re-visit bumps visitedAt rather than
    // adding a duplicate, which is what keeps the bounded recent-history list stable.
    userTarget: uniqueIndex('idx_user_recent_views_user_target').on(t.userId, t.campaignId, t.entityType, t.entityId),
    user: index('idx_user_recent_views_user').on(t.userId),
  }),
);

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

/**
 * Server-level purge tombstones (issue #867). Survive the campaign hard-cascade
 * (no FK to campaigns) so operators can still discover who purged what, when,
 * and whether the destructive step completed or failed — even after every
 * campaign-scoped audit row becomes unreachable (memberships gone). Stores a
 * hash of the campaign name rather than the plaintext title.
 */
export const campaignPurgeTombstones = sqliteTable('campaign_purge_tombstones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  campaignNameHash: text('campaign_name_hash').notNull(),
  actor: text('actor').notNull(),
  // 'requested' | 'completed' | 'failed'
  status: text('status').notNull(),
  detail: text('detail').notNull().default(''),
  requestedAt: text('requested_at').notNull(),
  completedAt: text('completed_at'),
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

/** Persistent rule-pack import jobs (issue #737). */
export const importJobs = sqliteTable('import_jobs', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  sourceHash: text('source_hash').notNull().default(''),
  input: text('input').notNull().default('{}'),
  status: text('status').notNull().default('queued'),
  progress: text('progress').notNull().default('{}'),
  cursor: text('cursor'),
  actorId: text('actor_id').notNull().default(''),
  startedAt: text('started_at'),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  outcome: text('outcome'),
  errors: text('errors').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
});


export const rulePacks = sqliteTable('rule_packs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  version: text('version').notNull().default(''),
  license: text('license').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  kind: text('kind').notNull().default('base'),
  extendsPackSlug: text('extends_pack_slug'),
  installedAt: text('installed_at').notNull(),
  entryCount: integer('entry_count').notNull().default(0),
  // sha256 of the pack's CONTENT-ONLY manifest (provenance + every entry's content hash,
  // EXCLUDING the volatile `version` date label) as computed by packManifestHash, stamped on
  // every successful install/sync. Lets a re-import whose fetched manifest is byte-identical
  // short-circuit the per-entry read+sha256 classification (issue #1518). Excluding version
  // is what makes the short-circuit fire across a UTC day boundary too — every importer
  // except Open5e stamps version to today's date, so a version-inclusive hash would never
  // match a re-import done on a later day. '' on packs installed before this column existed
  // means "no tracked manifest" — the short-circuit treats that as a miss and runs the full
  // transactional classification, re-stamping the real hash. The hash never gates correctness
  // on its own: it only authorises skipping work that would itself be a no-op, because global
  // rule-entry content only ever changes through the import flow that re-stamps it.
  manifestHash: text('manifest_hash').notNull().default(''),
});

export const ruleEntries = sqliteTable('rule_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packId: integer('pack_id').notNull(),
  // NULL for globally installed/open-pack entries. Non-null rows are the owning campaign's
  // own homebrew — readable through the campaign homebrew endpoints AND (issue #1927) through
  // the encounter generator/preview candidate queries, scoped by campaign membership and
  // `isNull(archivedAt)` there; every reader must still scope by this column (or archivedAt),
  // never read cross-campaign.
  campaignId: integer('campaign_id'),
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
  rightsStatus: text('rights_status').notNull().default('open_licensed'),
  archivedAt: text('archived_at'),
  provenance: text('provenance').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Immutable before/after history for campaign homebrew only (issue #741). */
export const ruleEntryRevisions = sqliteTable('rule_entry_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ruleEntryId: integer('rule_entry_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  actor: text('actor').notNull(),
  beforeJson: text('before_json').notNull(),
  afterJson: text('after_json').notNull(),
  createdAt: text('created_at').notNull(),
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
  // Target entity `updatedAt` at propose time (issue #681). NULL for creates/legacy rows.
  baseUpdatedAt: text('base_updated_at'),
  // sha256 of the canonical base snapshot JSON at propose time (issue #681).
  baseSnapshotHash: text('base_snapshot_hash'),
  // Human-readable display name of the submitting user (issue #124).
  proposer: text('proposer').notNull(),
  // Stable id of the submitting user (String(users.id) or dev:<name>) — powers the
  // proposer self-view filter. Empty on rows written before this column existed.
  proposerUserId: text('proposer_user_id').notNull().default(''),
  // Token name when submitted via a PAT (secondary provenance), else NULL.
  proposerToken: text('proposer_token'),
  // Issue #501: structured, non-secret AI generation provenance for AI-authored
  // proposals (provider/model/endpoint/source IDs/prompt hash/consent). NULL for
  // manual/collab and legacy proposals.
  generationProvenance: text('generation_provenance'),
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
  title: text('title').notNull().default(''),
  caption: text('caption').notNull().default(''),
  altText: text('alt_text').notNull().default(''),
  creator: text('creator').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  license: text('license').notNull().default(''),
  rights: text('rights').notNull().default(''),
  attribution: text('attribution').notNull().default(''),
  checksumSha256: text('checksum_sha256'),
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
  // Internal monotonic token for a logical turn. Unlike round/index it also changes
  // when a DM undoes back to the same combatant, invalidating banked player previews.
  turnVersion: integer('turn_version').notNull().default(0),
  // Internal ABA guard for removal undo. Unlike turnVersion, ordinary combatant
  // state changes advance this counter without invalidating player action previews.
  combatantStateVersion: integer('combatant_state_version').notNull().default(0),
  escalationDie: integer('escalation_die').notNull().default(0),
  escalationDieHeld: integer('escalation_die_held', { mode: 'boolean' }).notNull().default(false),
  escalationDieOverride: integer('escalation_die_override'),
  escalationDieHistory: text('escalation_die_history'),
  turnIndex: integer('turn_index').notNull().default(0),
  // Identity-based turn pointer (issue #49) — the combatant whose turn it is,
  // independent of positional shuffling on add/remove. null when not running/empty.
  currentCombatantId: integer('current_combatant_id'),
  // Boss-fight scheduling (issue #618): 'combatant' | 'lair' (initiative count 20 slot).
  turnPhase: text('turn_phase').notNull().default('combatant'),
  lairResumeCombatantId: integer('lair_resume_combatant_id'),
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
  // Hex orientation (issue #467): 'pointy' | 'flat'. Default pointy matches legacy overlay.
  hexOrientation: text('hex_orientation').notNull().default('pointy'),
  aoe: text('aoe'),
  // Grid calibration (issue #417) — align the overlay to a map's printed grid. All in
  // percent-of-map-width units; defaults reproduce the pre-#417 top-left square grid.
  // Added by migration on older DBs (see db/db.module.ts migrateEncountersTableForGridCalibration).
  gridOffsetX: real('grid_offset_x').notNull().default(0),
  gridOffsetY: real('grid_offset_y').notNull().default(0),
  gridCellHeight: real('grid_cell_height'),
  gridRotation: real('grid_rotation').notNull().default(0),
  gridOpacity: real('grid_opacity').notNull().default(0.35),
  // Entity-level secrecy (issue #262) — see quests.hidden. A hidden encounter's roster +
  // difficulty are DM-only, and the encounter is dropped wholesale from non-DM reads until
  // the DM reveals it. Added by migration on older DBs (see db/db.module.ts).
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  // Monster-HP display dial for non-DM viewers (issue #1925): 'band'|'exact'|'hidden'.
  // Added by migration on older DBs (see db/db.module.ts migrateEncountersTableForMonsterHpDisplay1925).
  monsterHpDisplay: text('monster_hp_display').notNull().default('band'),
  endedAt: text('ended_at'),
  // Turn timer (issue #1935): server-stamped instant the CURRENT turn began, so every
  // connected client agrees on elapsed time — never client-computed. null when not actively
  // mid-turn (preparing or ended). Added by migration on older DBs (see db/db.module.ts).
  turnStartedAt: text('turn_started_at'),
  // DM-set pacing limit in seconds; 0 = off (elapsed-only, DM-facing chip). Never enforced
  // server-side. Added by migration on older DBs (see db/db.module.ts).
  turnTimerSeconds: integer('turn_timer_seconds').notNull().default(0),
  // Issue #473: DM deferred the post-encounter aftermath panel (idempotent resume).
  aftermathDismissedAt: text('aftermath_dismissed_at'),
  // Issue #1448: Aftermath mutations tracking (XP award timestamp and stored loot list package).
  aftermathXpAwardedAt: text('aftermath_xp_awarded_at'),
  aftermathLoot: text('aftermath_loot'),
  // Soft-delete / trash timestamp (issue #701) — see campaigns.deletedAt.
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Current-format, server-authoritative token batch intents (issue #761). */
export const encounterTokenBatches = sqliteTable('encounter_token_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  encounterId: integer('encounter_id').notNull().references(() => encounters.id, { onDelete: 'cascade' }),
  campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  previewToken: text('preview_token').notNull(),
  fingerprint: text('fingerprint').notNull(),
  status: text('status').notNull().default('previewed'),
  beforeJson: text('before_json').notNull(),
  planJson: text('plan_json').notNull(),
  afterJson: text('after_json'),
  resultJson: text('result_json'),
  applyKey: text('apply_key'),
  undoKey: text('undo_key'),
  createdAt: text('created_at').notNull(),
  appliedAt: text('applied_at'),
  undoneAt: text('undone_at'),
}, (table) => ({ preview: uniqueIndex('idx_encounter_token_batches_preview').on(table.previewToken), actorApply: uniqueIndex('idx_encounter_token_batches_actor_apply').on(table.actorId, table.applyKey), actorUndo: uniqueIndex('idx_encounter_token_batches_actor_undo').on(table.actorId, table.undoKey) }));

export const campaignTokenFormations = sqliteTable('campaign_token_formations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  layoutJson: text('layout_json').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({ campaign: index('idx_campaign_token_formations_campaign').on(table.campaignId), name: uniqueIndex('idx_campaign_token_formations_name').on(table.campaignId, table.name) }));

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
  // Issue #673: honest provenance for paper-table / physical rolls logged by a DM.
  source: text('source').notNull().default('rolled'),
  actor: text('actor'),
  natural20: integer('natural20'),
  // Issue #1904: optional identity ties for later read-time redaction (see RollResult in
  // packages/schema for the full rationale) — null for the vast majority of rolls.
  encounterId: integer('encounter_id'),
  npcId: integer('npc_id'),
  // #1511: additive shared-roll context. Legacy rows keep the table-wide default.
  characterId: integer('character_id'),
  combatantId: integer('combatant_id'),
  visibility: text('visibility').notNull().default('party_shared'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  campaignVisibility: index('idx_dice_rolls_campaign_visibility_id_desc').on(table.campaignId, table.visibility, table.id),
  campaignRoller: index('idx_dice_rolls_campaign_roller_id_desc').on(table.campaignId, table.rollerUserId, table.id),
}));

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
  // Issue #820: optional JSON blob (ScheduleNotificationData for session_scheduled).
  data: text('data'),
  // Issue #2112: private, server-only authority context for hidden encounter
  // status rows. Never returned in the public Notification shape.
  hiddenStatusContext: text('hidden_status_context'),
  actorName: text('actor_name').notNull().default(''),
  // Issue #597: WHO caused this row, as a note-identity id (String(users.id) or
  // `dev:<name>`). Until now only the display NAME was kept, so a recipient who later
  // blocked someone could not have their existing bell items filtered — a name is not
  // an identity and two members may share one. Nullable/'' for rows written before
  // this column existed and for system-generated events with no human actor.
  actorUserId: text('actor_user_id'),
  readAt: text('read_at'),
  createdAt: text('created_at').notNull(),
});

// Issue #789 — per-user, per-campaign, per-category notification mode
// ('immediate' | 'digest' | 'muted'). Absent row => the category default
// (immediate). One row per (user, campaign, category); consulted during fan-out.
export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(), // recipient users.id (FK->users ON DELETE CASCADE in DDL)
    campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE in DDL
    category: text('category').notNull(), // NotificationCategory in @campfire/schema
    mode: text('mode').notNull().default('immediate'), // NotificationDeliveryMode
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    userCampaignCategory: uniqueIndex('idx_notification_prefs_user_campaign_category').on(
      t.userId,
      t.campaignId,
      t.category,
    ),
  }),
);

// Issue #789 — per-user, per-campaign quiet-hours window (local minutes-of-day in
// `timezone`). Absent row => quiet hours disabled. Suppresses only non-critical
// IMMEDIATE notifications, which are deferred then flushed once the window passes.
export const notificationQuietHours = sqliteTable(
  'notification_quiet_hours',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    campaignId: integer('campaign_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    startMinute: integer('start_minute').notNull().default(1320),
    endMinute: integer('end_minute').notNull().default(420),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    userCampaign: uniqueIndex('idx_notification_quiet_hours_user_campaign').on(t.userId, t.campaignId),
  }),
);

// Issue #789 — deferred notification store. Rows land here instead of
// `notifications` when the recipient's category mode is 'digest', or when an
// 'immediate' notification arrives inside their quiet-hours window
// (reason distinguishes the two). NotificationsService.flushDigests() drains
// eligible rows into real notifications on the digest cadence.
export const notificationDigestQueue = sqliteTable('notification_digest_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  entityType: text('entity_type'),
  entityId: integer('entity_id'),
  commentId: integer('comment_id'),
  data: text('data'),
  // Mirrors notifications.hidden_status_context while a row is deferred.
  hiddenStatusContext: text('hidden_status_context'),
  actorName: text('actor_name').notNull().default(''),
  // Issue #597: carried through the deferral so a flushed digest row lands in
  // `notifications` with the same actor identity an immediate row would have had.
  actorUserId: text('actor_user_id'),
  reason: text('reason').notNull().default('digest'), // 'digest' | 'quiet_hours'
  createdAt: text('created_at').notNull(),
});

// Issue #1323 — one browser Push API subscription per opaque endpoint. The
// endpoint is globally unique so signing into a different Campfire account in
// the same browser transfers that browser subscription instead of notifying two
// accounts. Encryption keys are the public subscription material produced by
// PushManager; the VAPID private key remains environment-only.
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => ({
    endpoint: uniqueIndex('idx_push_subscriptions_endpoint').on(t.endpoint),
    user: index('idx_push_subscriptions_user').on(t.userId),
  }),
);

// Issue #789 — dedup ledger for scheduled-session reminders and unanswered-RSVP
// nudges. One row per (schedule, user, kind) guarantees a reminder/nudge is sent
// at most once, so a reschedule or a retried sweep never double-sends.
export const notificationReminders = sqliteTable(
  'notification_reminders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scheduledSessionId: integer('scheduled_session_id').notNull(),
    userId: integer('user_id').notNull(),
    kind: text('kind').notNull(), // 'session_reminder' | 'rsvp_nudge'
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    sessionUserKind: uniqueIndex('idx_notification_reminders_session_user_kind').on(
      t.scheduledSessionId,
      t.userId,
      t.kind,
    ),
  }),
);

// DM-initiated check requests (issue #415) — one row per (request, target character). A DM
// asks selected players to roll a check/save with an optional DC + consequence; the targeted
// player reads their pending row(s) over a permission-checked REST read, rolls once via the
// existing catalog-roll path, and the row is marked resolved (roll_id links the dice-log roll).
// Cascades on campaign/character delete so a purge never strands a request.
export const checkRequests = sqliteTable('check_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE (bootstrap/migration)
  characterId: integer('character_id').notNull(), // FK->characters ON DELETE CASCADE — the target sheet
  encounterId: integer('encounter_id'), // optional context link; nullable
  checkId: text('check_id').notNull(), // stable catalog id, e.g. 'save:DEX'
  checkLabel: text('check_label').notNull().default(''), // resolved label snapshot ('DEX save')
  mode: text('mode').notNull().default('flat'), // 'flat' | 'advantage' | 'disadvantage'
  dc: integer('dc'), // optional difficulty class
  consequence: text('consequence').notNull().default(''), // DM-authored consequence text
  status: text('status').notNull().default('pending'), // 'pending' | 'resolved'
  requestedByUserId: text('requested_by_user_id').notNull(), // RequestUser.id of the DM
  requestedByName: text('requested_by_name').notNull().default(''),
  rollId: integer('roll_id'), // dice_rolls.id once resolved; null while pending
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  groupId: text('group_id'), // issue #1943: shared across every row one requestChecks() call creates; null for pre-existing rows
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
  ruleEntryId: integer('rule_entry_id'),
  compendiumRef: text('compendium_ref'),
  compendiumSnapshot: text('compendium_snapshot'),
  compendiumState: text('compendium_state'),
  // Equip state (issue #1326). equipped only ever true for ownerType='character';
  // equipSlot is a free-form per-character slot key, required while equipped.
  // equippedAction is JSON-serialized CharacterAction, surfaced by the action resolver
  // while the item is equipped.
  equipped: integer('equipped', { mode: 'boolean' }).notNull().default(false),
  equipSlot: text('equip_slot'),
  equippedAction: text('equipped_action'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // Soft-delete tombstone (issue #551): NULL == live; ISO timestamp == trashed.
  deletedAt: text('deleted_at'),
  deletedBy: text('deleted_by'),
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
  tokensReserved: integer('tokens_reserved').notNull().default(0),
  tokensRefunded: integer('tokens_refunded').notNull().default(0),
  tokensUnknown: integer('tokens_unknown').notNull().default(0),
  tokensOverage: integer('tokens_overage').notNull().default(0),
  turnCount: integer('turn_count').notNull().default(0),
  lastTurnAt: text('last_turn_at'),
  /** Proactive DM settings per campaign (#1044). */
  proactiveSettings: text('proactive_settings', { mode: 'json' }).$type<AiDmProactiveSettings>().default({} as any),
  /** Structured table style (#1049): tone/pacing/verbosity/combat/NPC depth, JSON-encoded.
   *  One JSON column rather than five scalars, matching `proactive_settings` above — the whole
   *  block is read, written and (for #1070's cross-campaign reuse) copied as one value. */
  stylePresets: text('style_presets', { mode: 'json' }).$type<AiDmStylePresets>().default({} as any),
  /** Comprehension profile (#874): reading complexity/paragraph length/sensory intensity/choice
   *  count, JSON-encoded. Same one-JSON-column shape as `style_presets` above, for the same
   *  reason — read, written and copied as one value. */
  comprehensionProfile: text('comprehension_profile', { mode: 'json' }).$type<AiDmComprehensionProfile>().default({} as any),
  /** Depth cap for the FIFO action queue when turns are submitted while running (#1045). */
  actionQueueDepth: integer('action_queue_depth').default(8),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Durable AI Driver control state (issue #559). This is intentionally separate from
// ai_dm_seats config/counters: it stores the live recovery controls that used to be
// process-local only (pause, takeover, votes, stuck state, and replay input).
export const aiDriverControlState = sqliteTable('ai_driver_control_state', {
  campaignId: integer('campaign_id').primaryKey(),
  status: text('status').notNull().default('idle'),
  state: text('state').notNull().default('running'),
  scene: text('scene'),
  lastNarration: text('last_narration'),
  lastTurnAt: text('last_turn_at'),
  turnCount: integer('turn_count').notNull().default(0),
  stuck: text('stuck'),
  actingDm: text('acting_dm'),
  vote: text('vote'),
  takeoverRequestedBy: text('takeover_requested_by'),
  lastInput: text('last_input'),
  /** The recovery shape last announced to the table — suppresses re-announcing a steady state. */
  announcedRecovery: text('announced_recovery'),
  /**
   * #1042 — JSON map of unconsumed secret-read approvals (#557) and queued confirm-policy tool
   * calls (#474). Persisted to be REVOKED loudly on the next boot, never to be restored: both
   * are grants of authority made to a room whose composition the server cannot re-verify after
   * a restart. Hydration audits each, signals the table, and clears the column.
   */
  secretReadApprovals: text('secret_read_approvals'),
  pendingToolConfirmations: text('pending_tool_confirmations'),
  /** #1043 — session lifecycle phase: greeting | active | wrap_up | ended. Defaults to 'active'. */
  phase: text('phase').notNull().default('active'),
  /** #1051 — collaborative handoff: the AI narrates, a DM confirms mechanical commits. */
  collaborative: integer('collaborative', { mode: 'boolean' }).notNull().default(false),
  /** #1781 / #1495 — cumulative aftermath economy-grant budget window state. */
  aftermathGrantWindow: text('aftermath_grant_window'),
  updatedAt: text('updated_at').notNull(),
});

// AI DM per-turn usage history (issue #1060). One row per metered turn (driver step or
// co-DM draft or scribe run). Used to power a per-campaign usage-history endpoint and
// the DM settings sparkline. Written by AiDmService.meterTurn as best-effort — a
// failure here must never break the metering transaction, so the insert is fire-and-
// forget with its own try/catch.
export const aiDmUsageHistory = sqliteTable('ai_dm_usage_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  tokensUsed: integer('tokens_used').notNull(),
  action: text('action').notNull().default(''), // 'ai-dm.driver.turn' | 'ai-dm.scribe' | ...
  model: text('model').notNull().default(''),
  actor: text('actor').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

// Authoritative multi-player AI-DM table transcript (issue #572). One row per durable
// transcript event, written by AiDmTranscriptService BEFORE the matching frame is
// broadcast on the narration SSE channel — so a client that reconnects and pages from
// its last seq can never miss an event other clients already rendered.
//
// `seq` is a PER-CAMPAIGN monotonic counter assigned inside the same synchronous
// better-sqlite3 transaction as the insert: the ordering key, the pagination cursor and
// the reconnect watermark, all in one. Not `createdAt` (wall clock is not a total order)
// and not the global `id` (it interleaves across campaigns). UNIQUE (campaignId, seq).
// `eventId` is the stable client-visible identity (server-minted uuid, unique per
// campaign) used to merge the same event arriving twice (live SSE + a page fetch).
// `clientRef` is the sender's optimistic-echo CORRELATION token (not an idempotency
// key) — echoed back so the submitting browser replaces its local entry in place.
// `turnId` groups one driver turn's narration/tool/turn-end rows into one DM bubble.
// `visibility` is row-level redaction ('all' | 'dm'); field-level redaction of a hidden
// encounter id inside a tool payload reuses projectAiDmToolEventForRole instead.
//
// narration.delta is deliberately NOT stored — narration.message is the aggregated
// authoritative text per step, and persisting every token chunk would blow the table up
// ~100x per turn for no added information.
export const aiDmTranscriptEvents = sqliteTable('ai_dm_transcript_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  seq: integer('seq').notNull(),
  eventId: text('event_id').notNull(),
  kind: text('kind').notNull(), // AiDmTranscriptEventKind
  actorUserId: text('actor_user_id'),
  actorName: text('actor_name'),
  clientRef: text('client_ref'),
  turnId: text('turn_id'),
  payload: text('payload').notNull().default('{}'), // JSON-encoded, kind-specific
  visibility: text('visibility').notNull().default('all'), // 'all' | 'dm'
  createdAt: text('created_at').notNull(),
});

// AI provider config storage (issue #310): provider selection + ENCRYPTED API key
// at two scopes — 'server' (admin default) and 'campaign' (per-campaign override,
// DM-managed, cascades on campaign delete). `encrypted_api_key` holds an aes-256-gcm
// ciphertext (see common/crypto.ts encryptSecret); the plaintext key is NEVER
// stored/returned/logged/exported — reads expose only `key_last4`.
//
// #1052 — each scope holds one row PER ROLE, not one row outright. The partial unique
// indexes are keyed on `(scope, role)` and `(campaign_id, role)`, so a scope may hold a
// 'primary' AND a 'fallback' — which is the entire point of the optional fallback provider.
// At most one of EACH role per scope still holds: widening the uniqueness did not remove it.
// See db.module.ts bootstrap + migrateAiProviderConfigFallbackRole1052.
//
// The widening is safe on existing data, and not by luck: the OLD indexes were STRICTER
// (one row per scope, full stop), so every row satisfying them also satisfies the new ones.
// Migration 0135 backfills `role = 'primary'` on every pre-existing row, and because there
// was at most one row per scope to begin with, that backfill cannot produce two rows sharing
// a `(scope, role)` pair. Relaxing a unique index can never collide on data that already
// satisfied the tighter one.
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
  /**
   * #1052: 'primary' | 'fallback'. A fallback row is a SECOND, fully independent provider
   * config at the same scope, used only after the primary exhausts its retries on a TRANSIENT
   * failure. Modelled as its own row rather than extra columns on the primary so it carries
   * its own key, base URL, and provider type as one unit — the #373 invariant is that whoever
   * owns the key owns the endpoint, and a half-config sharing the primary's key would break it.
   * The partial unique indexes are keyed on (scope, role) / (campaign_id, role).
   */
  role: text('role').notNull().default('primary'),
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
  // Durable cursor for cron/incremental assembly (#499).
  sourceCursorAt: text('source_cursor_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const aiScribeJobs = sqliteTable(
  'ai_scribe_jobs',
  {
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
    // Post-session exactly-once binding + archived assembly counts (#499).
    scheduledSessionId: integer('scheduled_session_id'),
    sourceStats: text('source_stats'),
    // Issue #501: same generation provenance as the filed proposal, retained even
    // for dry-run/no-proposal results.
    generationProvenance: text('generation_provenance'),
    createdBy: text('created_by').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    campaignIdx: index('idx_ai_scribe_jobs_campaign').on(t.campaignId, t.createdAt),
    sessionTriggerIdx: index('idx_ai_scribe_jobs_session_trigger').on(t.campaignId, t.scheduledSessionId, t.trigger),
    campaignStatusHashIdx: index('idx_ai_scribe_jobs_campaign_status_hash').on(t.campaignId, t.status, t.sourceHash),
  }),
);

// Inbox sweep (issue #1644) — one row per `POST /campaigns/:id/inbox/sweep` call, the
// auditable job record the issue requires. Per-item outcomes live in `inboxSweepItems`.
export const inboxSweepJobs = sqliteTable('inbox_sweep_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE
  status: text('status').notNull(), // InboxSweepJobStatus: 'succeeded' | 'disabled'
  itemsTotal: integer('items_total').notNull().default(0),
  itemsProposed: integer('items_proposed').notNull().default(0),
  itemsSkipped: integer('items_skipped').notNull().default(0),
  itemsErrored: integer('items_errored').notNull().default(0),
  // #1716 review: a durable snapshot of the completed `InboxSweepResult` so the poll
  // endpoint can return the same per-item outcomes (including non-ledgered ones) the
  // synchronous fast path returns, instead of reconstructing a subset from `inbox_sweep_items`.
  snapshot: text('snapshot'),
  detail: text('detail').notNull().default(''),
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

// Per-inbox-item sweep ledger (issue #1644). Serves two purposes: (1) the durable
// per-item outcome the response is built from, and (2) the IDEMPOTENCY mechanism — a
// UNIQUE(campaign_id, note_id) row is written the moment a proposal is filed (or an
// item is dismissed/skipped-as-unsupported) so a re-sweep never re-infers or refiles a
// SECOND proposal for the same inbox item. Deterministic classifier errors are persisted
// and resolved too, so invalid model output does not hot-loop on every sweep; consent- or
// provider-configuration gates intentionally remain open/unledgered so they can be retried
// after the underlying condition changes.
export const inboxSweepItems = sqliteTable('inbox_sweep_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE
  noteId: integer('note_id').notNull(), // FK->notes.id (the inbox item)
  jobId: integer('job_id').notNull(), // the sweep run that first produced this outcome
  outcome: text('outcome').notNull(), // InboxSweepOutcome: 'proposed' | 'skipped' | 'errored'
  entityType: text('entity_type'), // InboxSweepEntityType, when outcome='proposed' + action='update'
  entityId: integer('entity_id'),
  proposalId: integer('proposal_id'), // set when outcome='proposed'
  reason: text('reason').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const combatants = sqliteTable('combatants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  encounterId: integer('encounter_id').notNull(),
  kind: text('kind').notNull(), // 'character' | 'monster' | 'npc'
  characterId: integer('character_id'), // set when kind='character' — links back to characters.id
  // Issue #1941: delegated controller player (user id). Added by migration on older DBs.
  controllerUserId: integer('controller_user_id').references(() => users.id, { onDelete: 'set null' }),
  npcId: integer('npc_id'), // set when kind='npc' — links back to npcs.id (identity). Added by migration on older DBs.
  npcIdentitySourceId: integer('npc_identity_source_id'), // internal redaction source for unlinked duplicate NPCs
  npcDispositionSnapshot: text('npc_disposition_snapshot'), // encounter-time NPC disposition; nullable for legacy rows
  name: text('name').notNull(),
  initiative: integer('initiative'), // null until rolled
  initMod: integer('init_mod').notNull().default(0),
  initiativeBreakdown: text('initiative_breakdown'),
  // OSR group-initiative side label (issue #765). Combatants on the same side share one
  // d6 roll in group-mode systems. Nullable; added by migration on older DBs.
  initiativeGroup: text('initiative_group'),
  hpCurrent: integer('hp_current').notNull().default(10),
  hpMax: integer('hp_max').notNull().default(10),
  spCurrent: integer('sp_current').notNull().default(0),
  spMax: integer('sp_max').notNull().default(0),
  rpCurrent: integer('rp_current').notNull().default(0),
  rpMax: integer('rp_max').notNull().default(0),
  eac: integer('eac'),
  kac: integer('kac'),
  // Issue #1910: add-time snapshot of the linked character's speed. Nullable — see
  // @campfire/schema's Combatant.speed doc.
  speed: integer('speed'),
  // Temp HP + death-save subsystem (issue #57). Added by migration on older DBs;
  // see db/db.module.ts migrateCombatantsTableForHpModel().
  hpTemp: integer('hp_temp').notNull().default(0),
  deathState: text('death_state').notNull().default('none'), // 'none' | 'dying' | 'stable' | 'dead'
  deathSaveSuccesses: integer('death_save_successes').notNull().default(0),
  deathSaveFailures: integer('death_save_failures').notNull().default(0),
  conditions: text('conditions').notNull().default('[]'),
  ruleEntryId: integer('rule_entry_id'), // optional link to compendium rule_entries (monster statblock)
  sortOrder: integer('sort_order').notNull().default(0),
  // Issue #1923 review finding 1: DM manual-reorder override. Nullable; set on every
  // combatant row by EncountersService.reorderCombatant on a running encounter. See
  // @campfire/schema's Combatant.manualOrder doc for why this exists — a pure sortOrder
  // rewrite is not enough to hold a drag within a tie once the adapter tiebreak compares
  // initMod before sortOrder. Added by migration on older DBs (see
  // db/db.module.ts migrateCombatantsTableForManualOrder1923).
  manualOrder: integer('manual_order'),
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
  // Issue #413: current-turn workspace state as a JSON CombatantTurnState blob (per-turn
  // action-economy usage, movement, concentration, delay/ready) and structured active
  // effects as a JSON ActiveEffect[] blob (duration + save timing). Nullable; added by
  // migration on older DBs — see db/db.module.ts migrateCombatantsTableForTurnState().
  // null = defaults (EMPTY_TURN_STATE / []).
  turnState: text('turn_state'),
  activeEffects: text('active_effects'),
  // Issue #423: structured condition instances as a JSON ConditionInstance[] blob.
  conditionInstances: text('condition_instances'),
  // Issue #425: inline homebrew statblock JSON (CombatantStatblock) for manual monsters.
  statblockJson: text('statblock_json'),
  // Issue #1926: DM-controlled reveal of this combatant's statblock to non-DM viewers.
  // NOT NULL DEFAULT false — added by migration on older DBs (see
  // db/db.module.ts migrateCombatantsTableForStatblockRevealed1926).
  statblockRevealed: integer('statblock_revealed', { mode: 'boolean' }).notNull().default(false),
  // Issue #1921: limited-use/recharge action spend, a JSON map keyed by the server's
  // action fingerprint+source (see ActionResolverService.actionFingerprint/usesKeyFor) to
  // `{ spent }`. Nullable; added by migration on older DBs — see db/db.module.ts
  // migrateActionUsesTracking1921(). null = no action spent yet (all at max).
  actionUses: text('action_uses'),
});

/** One-shot, short-lived exact-row snapshots for combatant removal undo (issue #1469). */
export const combatantRemovalUndos = sqliteTable('combatant_removal_undos', {
  token: text('token').primaryKey(),
  requestKey: text('request_key'),
  // Retry keys belong to the authenticated principal, matching the other
  // encounter idempotency surfaces. A second DM must not receive the first
  // DM's capability merely because their clients generated the same key.
  actorId: text('actor_id').notNull().default(''),
  encounterId: integer('encounter_id').notNull(),
  combatantId: integer('combatant_id').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  beforeEncounterJson: text('before_encounter_json').notNull(),
  afterEncounterJson: text('after_encounter_json').notNull(),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
  createdAt: text('created_at').notNull(),
});

/** Campaign-scoped homebrew monster library (issue #425). */
export const campaignLibraryMonsters = sqliteTable('campaign_library_monsters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(),
  statblockJson: text('statblock_json').notNull(),
  sourceRuleEntryId: integer('source_rule_entry_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Campaign-owned taxonomy for the central library manager (issue #742). */
export const campaignLibraryTags = sqliteTable('campaign_library_tags', {
  id: integer('id').primaryKey({ autoIncrement: true }), campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(), aliasesJson: text('aliases_json').notNull().default('[]'), color: text('color').notNull().default('#64748b'),
  description: text('description').notNull().default(''), parentTagId: integer('parent_tag_id'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const campaignLibraryCollections = sqliteTable('campaign_library_collections', {
  id: integer('id').primaryKey({ autoIncrement: true }), campaignId: integer('campaign_id').notNull(),
  name: text('name').notNull(), aliasesJson: text('aliases_json').notNull().default('[]'), color: text('color').notNull().default('#64748b'),
  description: text('description').notNull().default(''), parentCollectionId: integer('parent_collection_id'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const campaignLibraryEntityTaxonomy = sqliteTable('campaign_library_entity_taxonomy', {
  id: integer('id').primaryKey({ autoIncrement: true }), campaignId: integer('campaign_id').notNull(), entityType: text('entity_type').notNull(), entityId: integer('entity_id').notNull(),
  tagId: integer('tag_id'), collectionId: integer('collection_id'), createdAt: text('created_at').notNull(),
});
export const campaignLibraryBulkOperations = sqliteTable('campaign_library_bulk_operations', {
  id: integer('id').primaryKey({ autoIncrement: true }), campaignId: integer('campaign_id').notNull(), actor: text('actor').notNull(), operation: text('operation').notNull(),
  beforeJson: text('before_json').notNull(), afterJson: text('after_json').notNull(), inverseJson: text('inverse_json').notNull(), undoneAt: text('undone_at'), undoneBy: text('undone_by'), createdAt: text('created_at').notNull(),
});
export const campaignLibraryTemplates = sqliteTable('campaign_library_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }), campaignId: integer('campaign_id').notNull(), entityType: text('entity_type').notNull(), name: text('name').notNull(), description: text('description').notNull().default(''),
  snapshotJson: text('snapshot_json').notNull(), sourceEntityId: integer('source_entity_id'), archivedAt: text('archived_at'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});

/**
 * Durable responsive derivatives for image attachments (issue #604). See the DDL in
 * bootstrap.sql.ts for the full rationale; in short, one row per (attachment, ladder
 * rung) makes derivative generation a once-ever, crash-recoverable background job
 * instead of a synchronous full-pixel decode on the request path.
 */
export const attachmentDerivatives = sqliteTable('attachment_derivatives', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attachmentId: integer('attachment_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  variant: text('variant').notNull(), // DerivativeVariantName: 'thumb' | 'md' | 'lg'
  state: text('state').notNull().default('pending'), // 'pending' | 'ready' | 'failed' | 'skipped'
  format: text('format').notNull().default(''), // always 'png' today (see DERIVATIVE_MIME)
  width: integer('width').notNull().default(0),
  height: integer('height').notNull().default(0),
  bytes: integer('bytes').notNull().default(0),
  checksum: text('checksum').notNull().default(''),
  /** Source content hash at generation time — a mismatch means this rung is stale. */
  sourceEtag: text('source_etag').notNull().default(''),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
  chainId: text('chain_id'),
  parentEventId: integer('parent_event_id'),
  phase: text('phase'),
  performedByJson: text('performed_by_json'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
});

// Issue #1449: server-side snapshot of an applied action chain (see ActionResolverService).
// Keyed on the SAME chainId already minted for the encounter_events correlation (issue #426)
// so `undo()` can look up the real pre-apply target snapshot by chainId alone, rather than
// trusting the client-supplied ActionUndoToken's `targets`/`hpBefore` values — the only
// server-side check before this was that `actorCombatantId` belonged to the encounter, so a
// forged token naming any combatant's id anywhere in the database was accepted verbatim.
// `undoneAt` makes a chain single-use: a replayed (or forged, or cross-encounter) token 400s
// rather than silently reverting whatever state now exists for that combatant.
export const actionApplyChains = sqliteTable('action_apply_chains', {
  id: text('id').primaryKey(), // the chain id (see ActionResolverService.applyInternal)
  encounterId: integer('encounter_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  actorCombatantId: integer('actor_combatant_id').notNull(),
  appliedByUserId: text('applied_by_user_id'),
  actionName: text('action_name').notNull().default(''),
  // The ActionTargetAllow the apply-time spec declared, replayed at undo for defense in depth.
  targetsAllow: text('targets_allow').notNull().default('any'),
  costSlot: text('cost_slot').notNull().default(''),
  costCount: integer('cost_count').notNull().default(0),
  spellLevelSpent: integer('spell_level_spent').notNull().default(0),
  concentrationBefore: text('concentration_before'),
  pendingConcentrationChecksBeforeJson: text('pending_concentration_checks_before_json').notNull().default('[]'),
  startedConcentration: integer('started_concentration', { mode: 'boolean' }).notNull().default(false),
  // Issue #1921: the limited-use/recharge spend key this apply wrote to the actor's
  // combatants.action_uses map (null when the action was untracked / at-will), and how much
  // was spent (0 when usesKey is null). undo() reads these to refund the exact spend rather
  // than re-deriving it from the (possibly since-edited) action spec.
  usesKey: text('uses_key'),
  usesSpent: integer('uses_spent').notNull().default(0),
  // The ActionUndoTarget[] pre-apply snapshot — the authoritative source undo() restores from.
  targetsJson: text('targets_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  undoneAt: text('undone_at'),
});

// Issue #1451: server-side snapshot of a RESOLVED (not-yet-necessarily-applied) action chain,
// keyed on the same chainId `ActionResolverService.resolve()` mints for every resolution. This
// closes the sibling hole to #1449: before this, `POST /actions/apply` took the FULL
// `ActionResolution` straight from the request body and applied its `totalDamage`/`healing`/
// `effects` verbatim — a player could preview a legitimate 6-damage hit, then re-POST that same
// object to `/actions/apply` with `totalDamage: 999999` (or an injected condition never in the
// action spec) against a target they were otherwise allowed to hit, one-shotting it. `apply()`
// now takes `{ chainId }` only and re-reads the resolution FROM THIS TABLE — the caller's copy
// of the resolution is never consulted, so the numbers that land are always the server's own
// roll.
//
// No `targetsAllow` column (review): unlike `action_apply_chains` — which UNDO deliberately
// snapshots, because undo restores a thing that already happened under the OLD rule — `apply()`
// always re-validates targeting against the CURRENT spec, never a resolve-time snapshot.
//
// No `consumedAt` column (review): a row is DELETED, not flagged, the instant it is claimed
// (`applyInternal`'s transaction) — this doubles as the single-use replay guard AND bounds this
// table's growth. An abandoned (never-applied) row is swept by
// `ActionResolverService.sweepStalePendingResolutions` on a TTL + per-encounter cap, so growth
// is bounded even for a preview nobody ever applies.
//
// `awaitingConfirmation` (review, second pass): true when this resolution needs a later human
// decision — either because it was minted under a dm-confirmed/player-declares policy
// (`!canApply` at resolve time), or because collaborative AI handoff queued its `apply_action`.
// Such a row is exempt from the age-based TTL entirely (a DM reviewing a queue must never have a
// legitimate declaration vanish out from under them), though it is still subject to the
// per-encounter cap — evicting one is audited and never silent, unlike an ordinary abandoned
// preview. See `sweepStalePendingResolutions`'s doc comment for the full reasoning.
export const actionPendingResolutions = sqliteTable('action_pending_resolutions', {
  id: text('id').primaryKey(), // the chain id (see ActionResolverService.resolve)
  encounterId: integer('encounter_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  actorCombatantId: integer('actor_combatant_id').notNull(),
  actionName: text('action_name').notNull().default(''),
  // Sheet/statblock action selected at resolve time. Names and indexes are not immutable on a
  // sheet, so apply() also compares this fingerprint before it trusts the current spec.
  actionIndex: integer('action_index'),
  actionFingerprint: text('action_fingerprint'),
  awaitingConfirmation: integer('awaiting_confirmation', { mode: 'boolean' }).notNull().default(false),
  // Player-owned previews are bound to the server's current encounter round. This lives only
  // in the pending row: clients submit the opaque chain id, never turn metadata they could forge.
  turnRound: integer('turn_round').notNull().default(0),
  // Bound at resolve time with the opaque chain. Legacy previews use -1 and fail
  // closed for players after the 0146 upgrade.
  turnVersion: integer('turn_version').notNull().default(-1),
  // The full server-computed ActionResolution (issue #414's byte-identical-preview payload),
  // serialized. This — not anything the client sends — is what `applyInternal` ever writes.
  resolutionJson: text('resolution_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});

// Issue #580: per-intent idempotency for non-idempotent encounter mutations (HP deltas and
// turn advancement). The row is written inside the SAME synchronous better-sqlite3
// transaction as the effect it guards, so claim and effect commit or roll back together.
//
// `responseJson` is the ORIGINAL response body (role-scoped via `responseRole`), replayed
// verbatim to a retry so an unreliable client can reconcile without guessing. It is
// nullable: the turn endpoints return the whole role-redacted encounter, which is derived
// asynchronously after the tx commits, so the claim lands first and the body is backfilled
// immediately after — a replay that finds no body falls back to fresh server truth, never
// to re-executing the effect.
//
// Keyed on (actorId, operation, key): two DMs cannot collide, and reusing one key for a
// different operation (or a different encounter/campaign — see `encounterId`/`campaignId`)
// is a 409 rather than a cross-scope replay. Pruned by createdAt TTL on write.
export const encounterOpIdempotency = sqliteTable(
  'encounter_op_idempotency',
  {
    actorId: text('actor_id').notNull(),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    encounterId: integer('encounter_id').notNull(),
    campaignId: integer('campaign_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    responseJson: text('response_json'),
    responseRole: text('response_role'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.actorId, t.operation, t.key] }) }),
);

// Issue #577: server-side verdicts on the AI driver's factual claims.
//
// The driver's narration used to be accepted wholesale — an uncited free-form response with no
// retrieval completed the turn and was broadcast as authoritative DM narration. Each row here is
// one factual claim (a rules ruling or an assertion about existing canon) plus the SERVER's
// verdict on it. `status` is never the model's self-report: a claim is `supported` only when
// every id it cited was actually returned by an authorized, campaign-scoped read during the same
// turn, which is simultaneously an existence, scope, and authorized-retrieval proof.
//
// Rows are retained (not deleted) when unsupported: the table sees the claim labelled unverified
// and can dispute it. `correction` is the human's rebuttal, replayed into later system prompts.
export const aiDriverGroundingClaims = sqliteTable(
  'ai_driver_grounding_claims',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    /** The driver session's turn counter at the time the claim was made. */
    turn: integer('turn').notNull(),
    /** Position of the claim within that turn's verdict (stable ordering for the review card). */
    claimIndex: integer('claim_index').notNull(),
    /** 'rule' | 'canon' | 'narration'. */
    kind: text('kind').notNull(),
    claimText: text('claim_text').notNull(),
    /** 'supported' | 'unsupported' | 'corrected'. */
    status: text('status').notNull(),
    /** A GroundingReason code, e.g. 'not_retrieved' / 'no_citation' / 'false_application_claim'. */
    reason: text('reason').notNull(),
    /** JSON array of EvaluatedCitation — type/id/status/reason plus the evidence href. */
    citationsJson: text('citations_json').notNull().default('[]'),
    /** Provider NAME only — never the key or base URL. */
    provider: text('provider').notNull().default(''),
    /** The model id actually served for the turn. */
    model: text('model').notNull().default(''),
    createdAt: text('created_at').notNull(),
    correction: text('correction'),
    correctedBy: text('corrected_by'),
    correctedAt: text('corrected_at'),
  },
  (t) => ({ campaignIdx: index('idx_ai_driver_grounding_campaign').on(t.campaignId, t.id) }),
);

// ---------- campaign modules (issue #585) ----------
// A distributable package of campaign prep with a stable UUID, semver, authors,
// license, origin and dependency contract. `campaign_module_installs` is the identity
// + lineage row for one installed module in one campaign; everything in it lives in its
// own column, so renaming the campaign (or the module) cannot sever the lineage.
// DDL: db/bootstrap.sql.ts CAMPAIGN_MODULES_DDL, applied to upgraded DBs by
// migrateCampaignModules585() in db/db.module.ts.
export const campaignModuleInstalls = sqliteTable('campaign_module_installs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE (bootstrap/migration)
  /** The package UUID. UNIQUE per campaign — one install of a given module per campaign. */
  moduleId: text('module_id').notNull(),
  name: text('name').notNull(),
  /** Strict semver, validated on install/update. */
  version: text('version').notNull(),
  description: text('description').notNull().default(''),
  license: text('license').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  authorsJson: text('authors_json').notNull().default('[]'),
  compatibilityJson: text('compatibility_json').notNull().default('{}'),
  dependenciesJson: text('dependencies_json').notNull().default('[]'),
  /** The manifest exactly as installed — the identity baseline an update diffs against. */
  manifestJson: text('manifest_json').notNull().default('{}'),
  // ----- lineage (persisted independently of any name) -----
  originKind: text('origin_kind').notNull().default('install'), // ModuleOriginKind
  originSourceUrl: text('origin_source_url').notNull().default(''),
  upstreamModuleId: text('upstream_module_id'),
  upstreamVersion: text('upstream_version'),
  forkedAt: text('forked_at'),
  /** Once detached the install stops accepting upstream updates; lineage is kept as history. */
  detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
  detachedAt: text('detached_at'),
  installedAt: text('installed_at').notNull(),
  installedBy: text('installed_by').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

// Per-artifact BASELINE: the upstream content as it was installed, plus the local row it
// was materialized into and any overlay retained across a previous update. baselineHash is
// the BASE leg of the three-way compare — without it "locally edited" and "upstream
// changed" are indistinguishable.
export const campaignModuleArtifacts = sqliteTable('campaign_module_artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  installId: integer('install_id').notNull(), // FK->campaign_module_installs ON DELETE CASCADE
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE
  kind: text('kind').notNull(), // ModuleArtifactKind
  /** Publisher-assigned stable key — survives local id remapping and renames. */
  artifactKey: text('artifact_key').notNull(),
  name: text('name').notNull().default(''),
  /** Local row id in the kind's table, or NULL when the table deleted it. */
  entityId: integer('entity_id'),
  baselineHash: text('baseline_hash').notNull(),
  baselineJson: text('baseline_json').notNull().default('{}'),
  /** Fields where the campaign still diverges from the baseline, retained across updates. */
  overlayJson: text('overlay_json'),
  installedVersion: text('installed_version').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Pre-apply restore point. `stateJson` carries the install row, every artifact baseline
// row, and the live entity content, so rollback can restore edits, un-create additions
// and resurrect upstream deletions in one synchronous transaction.
export const campaignModuleSnapshots = sqliteTable('campaign_module_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  installId: integer('install_id').notNull(), // FK->campaign_module_installs ON DELETE CASCADE
  campaignId: integer('campaign_id').notNull(), // FK->campaigns ON DELETE CASCADE
  reason: text('reason').notNull().default('update'), // 'install' | 'update' | 'fork'
  fromVersion: text('from_version').notNull().default(''),
  toVersion: text('to_version').notNull().default(''),
  artifactCount: integer('artifact_count').notNull().default(0),
  stateJson: text('state_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull().default(''),
  rolledBackAt: text('rolled_back_at'),
});

// Issue #598: the incident trail for AI driver turns WITHHELD by a provider content filter or
// a model refusal.
//
// Every column here is a count or a piece of provenance, and that is the entire design. There
// is deliberately NO column for the withheld text, and no digest of it either: copying prose a
// provider just refused to stand behind into an audit table gives it a longer-lived, exportable
// home than the live stream it was kept off, which recreates the exposure this feature exists
// to prevent — and a hash of a short passage is a guessable commitment, i.e. the same thing
// with extra steps.
//
// What the counts DO answer: did any of it reach the table before the terminal frame arrived
// (`released_chars` — the residual the quarantine window did not cover), how much the delay
// line still had in hand (`withheld_chars`), did the same response also try to run tools
// (`suppressed_tool_calls`), which provider/model/turn, and whose action provoked it. That is
// enough for a DM to notice a pattern and act on it without anyone re-reading the content.
//
// READ `released_chars` FIRST. It is the exposure. `withheld_chars` is bounded by the
// quarantine window (~240 chars), so on a long refused reply it is small BECAUSE most of the
// reply had already aged out of the window and been broadcast — not because little was
// refused. The two together are roughly what the model generated; neither alone is.
export const aiDriverWithheldTurns = sqliteTable(
  'ai_driver_withheld_turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    /** The driver session's turn counter when the withhold fired. */
    turn: integer('turn').notNull(),
    /** Which tool-loop step of that turn was withheld (1-based). */
    step: integer('step').notNull(),
    /** Normalized terminal state: 'content_filter' (vendor policy) or 'refusal' (the model). */
    finishReason: text('finish_reason').notNull(),
    /** Provider NAME only — never the key, base URL, or headers. */
    provider: text('provider').notNull().default(''),
    /** The model id actually served for the step. */
    model: text('model').notNull().default(''),
    /**
     * Characters still inside the quarantine delay line when the refusal landed, and so never
     * broadcast. LENGTH ONLY — the text itself is discarded. BOUNDED BY THE WINDOW: this is
     * how much was held back AT THE CUT-OFF, not the total the model produced. See the note
     * above the table.
     *
     * NOT A REASSURANCE NUMBER. A small value on a long refusal means the reply OUTRAN the
     * window and most of it had already gone out — the opposite of "the model barely said
     * anything". `released_chars` is what says how much reached the table, and is the field to
     * read first.
     */
    withheldChars: integer('withheld_chars').notNull().default(0),
    /** Characters already broadcast when the refusal arrived — the residual exposure. */
    releasedChars: integer('released_chars').notNull().default(0),
    /** Tool calls carried by the same response. None were dispatched; this is how many. */
    suppressedToolCalls: integer('suppressed_tool_calls').notNull().default(0),
    /** Member whose action provoked the turn; NULL for a proactive/system turn. */
    triggeredByUserId: text('triggered_by_user_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ campaignIdx: index('idx_ai_driver_withheld_campaign').on(t.campaignId, t.id) }),
);

/**
 * Issue #587: a server operator's REQUEST that a campaign be exported.
 *
 * The catalog's whole premise is that an operator can locate and administer a
 * campaign without being able to read it. Handing the requester an export would
 * undo that in one call — a campaign export carries every quest, note,
 * session-zero line and dmSecret there is. So a request is stored as an ASK
 * addressed to the campaign's own DMs, who approve or deny it and who alone can
 * then run the existing DM-gated export route. No column here ever holds
 * exported content, and there is no admin route that returns one.
 *
 * `requestedBy` is the audit-actor string (`token:<name>` or a user id), matching
 * audit_log.actor so the two trails join without a second identity notion.
 */
export const campaignExportRequests = sqliteTable(
  'campaign_export_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    campaignId: integer('campaign_id').notNull(),
    /** Audit-actor string of the requesting operator. */
    requestedBy: text('requested_by').notNull(),
    /** Numeric user id as text when the requester was a real account; '' otherwise. */
    requestedByUserId: text('requested_by_user_id').notNull().default(''),
    /** Export profile asked for (see modules/export/export-profiles.ts). */
    profile: text('profile').notNull().default(''),
    /** Why the operator is asking. Required at the API layer and shown to the deciding DM. */
    justification: text('justification').notNull().default(''),
    /** 'pending' | 'approved' | 'denied' | 'cancelled'. */
    status: text('status').notNull().default('pending'),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    decisionNote: text('decision_note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    campaignIdx: index('idx_campaign_export_requests_campaign').on(t.campaignId, t.id),
    statusIdx: index('idx_campaign_export_requests_status').on(t.status, t.id),
  }),
);

// Table safety hold / X-Card (issue #599). One row per campaign carrying the CURRENT stop
// state, upserted rather than appended: activation must be idempotent and must never fail
// on a race, so "two participants tapped at once" resolves to one held table instead of a
// conflict either of them has to retry.
//
// Note the column that is absent: an anonymous activation must not hand an identity to this
// layer at all. The facilitator's release id is a separate accountable action, not an
// activator identity, and is retained only so its public label can follow an account change.
export const tableSafetyHolds = sqliteTable('table_safety_holds', {
  campaignId: integer('campaign_id').primaryKey(),
  /** True while play is frozen. The single field every gate reads. */
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  /** When the current hold was raised. First activation wins; re-activation does not move it. */
  activatedAt: text('activated_at'),
  /** Display name, ONLY for an explicitly attributed hold. NULL means anonymous *or* no hold. */
  activatedByName: text('activated_by_name'),
  anonymous: integer('anonymous', { mode: 'boolean' }).notNull().default(true),
  /** Lifetime activation count for this campaign — a count is not attributable. */
  activationCount: integer('activation_count').notNull().default(0),
  releasedAt: text('released_at'),
  /** The facilitator who released it. Always recorded: releasing is an accountable act. */
  releasedBy: text('released_by'),
  releasedByUserId: text('released_by_user_id'),
  /** A SafetyHoldRecovery value: resume | rewind | veil | scene_change | end. */
  recovery: text('recovery'),
  facilitatorNote: text('facilitator_note'),
  updatedAt: text('updated_at').notNull(),
});
