import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  dbFilePath,
  openDatabase,
  MIGRATION_NAMES,
  compareAppVersions,
  getRecordedAppVersion,
} from '../../src/db/db.module';
import { makeTempDataDir, writeOldSchemaDb, columnNames, countRows } from './fixtures';
import { legacyIcsUid } from '../../src/modules/sessions/ics.util';

/**
 * Integration coverage for the hand-rolled ADD-COLUMN / table-rebuild migrations
 * in db.module (issue #80). These run against a real better-sqlite3 file that is
 * deliberately created in an *old shape* (see writeOldSchemaDb): every column a
 * migration adds is missing, and every table carries a seeded row. openDatabase
 * must bring the schema forward without losing that data, and must be safe to
 * run again on the already-migrated file (boot is not once-only — DbHolder
 * re-runs it on every restore).
 *
 * No Nest bootstrap: this is a pure storage-layer spec, so it lives beside the
 * fast `*.spec.ts` unit layer (issue #79) rather than the HTTP e2e suites.
 */
describe('db migrations (real SQLite, old-shaped DB)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('adds every migrated column when upgrading an old-shaped DB', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      // users — the 12-step rebuild path (password_hash NOT NULL -> nullable) plus later ADDs.
      const userCols = columnNames(sqlite, 'users');
      expect(userCols).toEqual(expect.arrayContaining(['oidc_sub', 'accent_color', 'text_size']));

      expect(columnNames(sqlite, 'campaigns')).toEqual(
        expect.arrayContaining(['rule_system', 'map_attachment_id', 'ics_token', 'ics_token_expires_at', 'public_recap_sharing_enabled']),
      );
      expect(columnNames(sqlite, 'characters')).toEqual(
        expect.arrayContaining([
          'xp',
          'save_proficiencies',
          'skills',
          'actions',
          'spell_slots',
          'dm_secret',
          // 0056 (#711): death state + temp HP now persist on the character sheet so
          // ended encounters can reconcile dying/stable/dead/temp-HP back to canon.
          'hp_temp',
          'death_state',
          'death_save_successes',
          'death_save_failures',
        ]),
      );
      expect(columnNames(sqlite, 'quests')).toContain('hidden');
      expect(columnNames(sqlite, 'npcs')).toContain('hidden');
      expect(columnNames(sqlite, 'npcs')).toContain('icon_slug'); // 0037 (issue #302)
      expect(columnNames(sqlite, 'rule_entries')).toContain('icon_slug'); // 0038 (issue #305)
      expect(columnNames(sqlite, 'rule_packs')).toContain('manifest_hash'); // 0148 (issue #1518)
      expect(columnNames(sqlite, 'sessions')).toContain('dm_secret');
      expect(columnNames(sqlite, 'api_tokens')).toContain('admin_enabled');
      expect(columnNames(sqlite, 'oauth_access_tokens')).toEqual(
        expect.arrayContaining(['family_id', 'refresh_consumed_at', 'revoked_at', 'family_revoked_at']),
      );
      expect(
        (sqlite.pragma('index_list(oauth_access_tokens)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_oauth_access_tokens_family');
      expect(columnNames(sqlite, 'proposals')).toContain('snapshot');
      expect(columnNames(sqlite, 'encounters')).toEqual(
        expect.arrayContaining(['current_combatant_id', 'location_id', 'quest_id', 'session_id', 'hidden']),
      );
      expect(columnNames(sqlite, 'combatants')).toEqual(
        expect.arrayContaining(['hp_temp', 'death_state', 'death_save_successes', 'death_save_failures', 'npc_id', 'npc_disposition_snapshot']),
      );
      expect(columnNames(sqlite, 'attachments')).toEqual(expect.arrayContaining(['hidden', 'state']));
      expect(columnNames(sqlite, 'inventory_items')).toContain('icon_slug'); // 0039 (issue #307)
      // 0045 (issue #503): comments gain the tombstone columns — soft delete without
      // destroying other members' replies (deleted_at) + who pulled the trigger (deleted_by).
      expect(columnNames(sqlite, 'comments')).toEqual(
        expect.arrayContaining([
          'deleted_at',
          'deleted_by',
          'character_id',
          'character_name',
          'character_avatar_url',
        ]),
      );

      // 0040 (issue #310): the ai_provider_configs table is created as a NEW table
      // by the migration, with the encrypted-key + scope columns present.
      expect(columnNames(sqlite, 'ai_provider_configs')).toEqual(
        expect.arrayContaining([
          'scope',
          'campaign_id',
          'provider_type',
          'base_url',
          'model',
          'params',
          'encrypted_api_key',
          'key_last4',
          'allowed_models',
        ]),
      );

      // 0041 (issue #311): ai_dm_seats gains the operating-mode column.
      expect(columnNames(sqlite, 'ai_dm_seats')).toContain('mode');
      expect(columnNames(sqlite, 'campaigns')).toContain('narration_language');
      // 0043 (issue #316): the AI scribe config + jobs tables are created as NEW
      // tables by the migration, with the trigger/budget + job-record columns present.
      expect(columnNames(sqlite, 'ai_scribe_configs')).toEqual(
        expect.arrayContaining(['campaign_id', 'post_session', 'cron', 'budget_per_run']),
      );
      expect(columnNames(sqlite, 'ai_scribe_jobs')).toEqual(
        expect.arrayContaining(['campaign_id', 'trigger', 'status', 'source_hash', 'proposal_id', 'proposal_count', 'tokens_used', 'provider']),
      );
      // 0052 (#877): a new participant-owned table, with privacy-safe defaults.
      expect(columnNames(sqlite, 'participant_support_preferences')).toEqual(
        expect.arrayContaining(['campaign_id', 'owner_user_id', 'owner_name', 'support_text', 'visibility', 'ai_use_consent']),
      );
      expect(columnNames(sqlite, 'campaign_members')).toContain('is_primary_owner');
      expect(columnNames(sqlite, 'campaign_guest_dm_grants')).toEqual(
        expect.arrayContaining([
          'campaign_id',
          'grantee_user_id',
          'granted_by_user_id',
          'scopes',
          'starts_at',
          'expires_at',
          'revoked_at',
          'handed_back_at',
        ]),
      );
      // 0123 (#588): organized-play decoration on the legacy scheduled_sessions
      // table, plus the new venue/room/series/exception/template tables.
      expect(columnNames(sqlite, 'scheduled_sessions')).toEqual(
        expect.arrayContaining([
          'status', // 0111 (#504) still applies to this old-shaped table
          'session_id',
          'series_id',
          'occurrence_index',
          'timezone',
          'local_start',
          'venue_id',
          'room_id',
          'assigned_dm_user_id',
          'capacity',
          'event_id',
          'season_id',
          'ics_uid',
          'ics_sequence',
          'original_scheduled_at',
        ]),
      );
      expect(columnNames(sqlite, 'play_venues')).toEqual(expect.arrayContaining(['name', 'timezone', 'address']));
      expect(columnNames(sqlite, 'play_rooms')).toEqual(expect.arrayContaining(['venue_id', 'name', 'capacity']));
      expect(columnNames(sqlite, 'session_series')).toEqual(
        expect.arrayContaining(['campaign_id', 'timezone', 'start_date', 'start_time', 'freq', 'interval', 'count', 'series_uid', 'status']),
      );
      expect(columnNames(sqlite, 'series_exceptions')).toEqual(
        expect.arrayContaining(['series_id', 'occurrence_id', 'recurrence_local_date', 'kind', 'from_scheduled_at', 'to_scheduled_at']),
      );
      expect(columnNames(sqlite, 'schedule_templates')).toEqual(expect.arrayContaining(['name', 'timezone', 'slots_json']));
    } finally {
      sqlite.close();
    }
  });

  /**
   * 0124 (#588). The backfilled UID must be EXACTLY the string the ICS feed has
   * always emitted for that row: minting a fresh one would tell every subscribed
   * calendar that the event was deleted and an unrelated one created in its place.
   */
  it('0124 backfills the pre-existing ICS UID rather than minting a new one', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      const row = sqlite
        .prepare(
          "SELECT id, campaign_id, ics_uid, ics_sequence, timezone, local_start, series_id FROM scheduled_sessions WHERE title = 'Legacy game night'",
        )
        .get() as {
        id: number;
        campaign_id: number;
        ics_uid: string;
        ics_sequence: number;
        timezone: string;
        local_start: string;
        series_id: number | null;
      };
      // Compared against legacyIcsUid() itself, not a hand-copied format string:
      // the invariant is "the migration and the feed agree", and two independent
      // copies of the same literal cannot detect the two drifting apart.
      expect(row.ics_uid).toBe(legacyIcsUid(row.campaign_id, row.id));
      expect(row.ics_uid).toBe(`campfire-c${row.campaign_id}-s${row.id}@campfire`);
      // The legacy row stays organized-play-neutral: no zone, no wall clock, no
      // series, no sequence bump. Nothing about an existing campaign changed.
      expect(row.ics_sequence).toBe(0);
      expect(row.timezone).toBe('');
      expect(row.local_start).toBe('');
      expect(row.series_id).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('preserves seeded rows and applies the declared defaults after migrating', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      // The 12-step users rebuild must keep the id/username/role of the legacy row.
      const user = sqlite.prepare('SELECT * FROM users WHERE username = ?').get('legacy-dm') as Record<string, unknown>;
      expect(user).toMatchObject({ id: 1, server_role: 'admin', password_hash: 'legacy-hash' });
      expect(user.oidc_sub).toBeNull();
      expect(user.text_size).toBe('default'); // NOT NULL DEFAULT applied to the pre-existing row.

      // ADD COLUMN with a default backfills existing rows.
      const campaign = sqlite.prepare('SELECT * FROM campaigns WHERE id = 1').get() as Record<string, unknown>;
      expect(campaign).toMatchObject({ name: 'Legacy Campaign', rule_system: '', public_recap_sharing_enabled: 1 });
      expect(campaign.ics_token).toBeNull();
      // 0049 (issue #554): the ICS token expiry column is added by migration on
      // old-shaped DBs, null on the legacy row (no expiry until the DM rotates).
      expect(campaign.ics_token_expires_at).toBeNull();

      const character = sqlite.prepare('SELECT * FROM characters WHERE id = 1').get() as Record<string, unknown>;
      expect(character).toMatchObject({ name: 'Legacy Hero', hp_current: 17, hp_max: 24, xp: 0, dm_secret: '' });
      expect(character.spell_slots).toBe('{}');
      // 0056 (#711): death state + temp HP columns backfill with safe defaults on the
      // pre-existing row — no one is secretly dead or carrying stale temp HP after upgrade.
      expect(character.hp_temp).toBe(0);
      expect(character.death_state).toBe('none');
      expect(character.death_save_successes).toBe(0);
      expect(character.death_save_failures).toBe(0);

      expect((sqlite.prepare('SELECT hidden FROM quests WHERE id = 1').get() as { hidden: number }).hidden).toBe(0);
      expect((sqlite.prepare('SELECT hidden FROM npcs WHERE id = 1').get() as { hidden: number }).hidden).toBe(0);
      // 0039 (issue #307): icon_slug ADD COLUMN backfills the pre-existing item with ''.
      expect((sqlite.prepare('SELECT icon_slug FROM inventory_items WHERE id = 1').get() as { icon_slug: string }).icon_slug).toBe('');
      expect((sqlite.prepare('SELECT admin_enabled FROM api_tokens WHERE id = 1').get() as { admin_enabled: number }).admin_enabled).toBe(0);
      expect(
        sqlite
          .prepare('SELECT family_id, refresh_consumed_at, revoked_at, family_revoked_at FROM oauth_access_tokens WHERE id = 1')
          .get(),
      ).toEqual({ family_id: 'legacy-1', refresh_consumed_at: null, revoked_at: null, family_revoked_at: null });
      expect((sqlite.prepare('SELECT snapshot FROM proposals WHERE id = 1').get() as { snapshot: unknown }).snapshot).toBeNull();
      // 0061 (#728): all pre-reservation attachment rows remain publicly visible.
      expect((sqlite.prepare('SELECT state FROM attachments WHERE id = 1').get() as { state: string }).state).toBe(
        'committed',
      );

      // Combatant HP-model backfill (issue #57): defaults applied to the pre-existing row.
      const combatant = sqlite.prepare('SELECT * FROM combatants WHERE id = 1').get() as Record<string, unknown>;
      expect(combatant).toMatchObject({ name: 'Legacy Goblin', hp_current: 5, hp_max: 7, hp_temp: 0, death_state: 'none' });
      expect(combatant.death_save_successes).toBe(0);
      expect(combatant.death_save_failures).toBe(0);
      expect(combatant.npc_id).toBeNull(); // 0044: npc_id ADD COLUMN — null for the pre-existing row



      // rule_entries icon_slug (0038, issue #305): ADD COLUMN default backfills the row.
      const ruleEntry = sqlite.prepare('SELECT * FROM rule_entries WHERE id = 1').get() as Record<string, unknown>;
      expect(ruleEntry).toMatchObject({ name: 'Legacy Fireball', type: 'spell', icon_slug: '' });

      // Every seeded table kept exactly its one row (nothing dropped by the rebuild).
      for (const table of ['users', 'campaigns', 'characters', 'quests', 'npcs', 'sessions', 'api_tokens', 'oauth_access_tokens', 'proposals', 'encounters', 'combatants', 'attachments', 'rule_entries', 'inventory_items']) {
        expect(countRows(sqlite, table)).toBe(1);
      }
      // 0045 (issue #503): both seeded comments survived the upgrade, and the
      // reply's parent_id threading is intact (reply still points at the root).
      // The new tombstone columns backfill to NULL on the pre-existing rows.
      expect(countRows(sqlite, 'comments')).toBe(2);
      expect(countRows(sqlite, 'participant_support_preferences')).toBe(0);
      sqlite.prepare(
        "INSERT INTO participant_support_preferences (campaign_id, owner_user_id, support_text, created_at, updated_at) VALUES (1, '1', 'legacy-upgrade-check', '2025-01-01', '2025-01-01')",
      ).run();
      expect(
        sqlite.prepare('SELECT visibility, ai_use_consent FROM participant_support_preferences').get(),
      ).toEqual({ visibility: 'facilitator', ai_use_consent: 0 });
      const legacyRoot = sqlite
        .prepare("SELECT body, parent_id, deleted_at, deleted_by, character_id, character_name, character_avatar_url FROM comments WHERE parent_id IS NULL")
        .get() as {
          body: string;
          parent_id: number | null;
          deleted_at: string | null;
          deleted_by: string | null;
          character_id: number | null;
          character_name: string | null;
          character_avatar_url: string | null;
        };
      expect(legacyRoot.body).toBe('Legacy root comment');
      expect(legacyRoot.deleted_at).toBeNull();
      expect(legacyRoot.deleted_by).toBeNull();
      expect(legacyRoot.character_id).toBeNull();
      expect(legacyRoot.character_name).toBeNull();
      expect(legacyRoot.character_avatar_url).toBeNull();
      const legacyReply = sqlite
        .prepare("SELECT body, parent_id FROM comments WHERE body = 'Legacy reply that must survive'")
        .get() as { body: string; parent_id: number };
      expect(legacyReply.parent_id).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('relaxes users.password_hash to nullable so an OIDC-only row can be inserted', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const { sqlite } = openDatabase(dataDir);
    try {
      // Would have thrown against the old NOT NULL constraint; the rebuild dropped it.
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO users (username, display_name, password_hash, oidc_sub, created_at, updated_at) VALUES ('oidc-user', 'OIDC User', NULL, 'sub-123', '2025-01-01', '2025-01-01')",
          )
          .run(),
      ).not.toThrow();
      const row = sqlite.prepare('SELECT password_hash, oidc_sub FROM users WHERE username = ?').get('oidc-user');
      expect(row).toEqual({ password_hash: null, oidc_sub: 'sub-123' });
    } finally {
      sqlite.close();
    }
  });

  it('is idempotent — re-running migrations on the already-migrated file is a no-op', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    // First upgrade.
    const first = openDatabase(dataDir);
    const usersAfterFirst = columnNames(first.sqlite, 'users').sort();
    first.sqlite.close();

    // DbHolder re-opens the same file on every restore — this must not throw or
    // re-run a rebuild, and the schema/data must be byte-for-byte the same.
    const second = openDatabase(dataDir);
    try {
      expect(columnNames(second.sqlite, 'users').sort()).toEqual(usersAfterFirst);
      expect(countRows(second.sqlite, 'users')).toBe(1);
      expect(countRows(second.sqlite, 'characters')).toBe(1);
      // A third pass for good measure — still stable.
      const third = openDatabase(dataDir);
      expect(columnNames(third.sqlite, 'campaigns')).toContain('ics_token');
      third.sqlite.close();
    } finally {
      second.sqlite.close();
    }
  });

  it('keeps legacy large rows compatible and stores comfortable in the existing TEXT column', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const first = openDatabase(dataDir);
    first.sqlite.prepare("UPDATE users SET text_size = 'large' WHERE id = 1").run();
    first.sqlite.close();

    const second = openDatabase(dataDir);
    expect((second.sqlite.prepare('SELECT text_size FROM users WHERE id = 1').get() as { text_size: string }).text_size).toBe('large');
    second.sqlite.prepare("UPDATE users SET text_size = 'comfortable' WHERE id = 1").run();
    second.sqlite.close();

    const third = openDatabase(dataDir);
    try {
      expect((third.sqlite.prepare('SELECT text_size FROM users WHERE id = 1').get() as { text_size: string }).text_size).toBe('comfortable');
    } finally {
      third.sqlite.close();
    }
  });

  it('creates a fully-formed DB from scratch and reports FTS availability', () => {
    dataDir = makeTempDataDir();
    const { sqlite, orm, ftsAvailable, campaignSearchFtsAvailable } = openDatabase(dataDir);
    try {
      expect(orm).toBeDefined();
      // better-sqlite3's bundled build ships fts5, so the probe should succeed here.
      expect(ftsAvailable).toBe(true);
      expect(campaignSearchFtsAvailable).toBe(true);
      // Fresh DB already has the modern columns (never touched a migration path).
      expect(columnNames(sqlite, 'characters')).toEqual(expect.arrayContaining(['xp', 'dm_secret', 'spell_slots']));
      expect(columnNames(sqlite, 'users')).toEqual(expect.arrayContaining(['oidc_sub', 'accent_color', 'text_size']));
      expect(columnNames(sqlite, 'attachments')).toEqual(expect.arrayContaining(['hidden', 'state']));
      // Migrations run before bootstrap on an empty DATA_DIR, so new pending-resolution
      // columns must be present in the bootstrap DDL as well as the upgrade migration.
      expect(columnNames(sqlite, 'action_pending_resolutions')).toEqual(expect.arrayContaining(['turn_round', 'turn_version']));
      expect(columnNames(sqlite, 'encounters')).toContain('turn_version');
      expect(
        sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'")
          .get(),
      ).toEqual(expect.objectContaining({ sql: expect.stringContaining("state IN ('reserved', 'committed')") }));
      // Issue #744: campaigns carry the one-authoritative-live-fight pointer on fresh DBs.
      expect(columnNames(sqlite, 'campaigns')).toEqual(expect.arrayContaining(['active_encounter_id']));

      expect(columnNames(sqlite, 'oauth_access_tokens')).toEqual(
        expect.arrayContaining(['family_id', 'refresh_consumed_at', 'revoked_at', 'family_revoked_at']),
      );
      expect(
        (sqlite.pragma('index_list(oauth_access_tokens)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_oauth_access_tokens_family');
      expect(columnNames(sqlite, 'participant_support_preferences')).toEqual(
        expect.arrayContaining(['owner_user_id', 'support_text', 'visibility', 'ai_use_consent']),
      );
      expect(MIGRATION_NAMES).toContain('0055_participant_support_preferences');
      expect(MIGRATION_NAMES).toContain('0057_campaigns_active_encounter');
      expect(MIGRATION_NAMES).toContain('0058_campaigns_public_invites_enabled');
      expect(MIGRATION_NAMES).toContain('0059_public_invites_disabled_inactive');
      expect(MIGRATION_NAMES).toContain('0060_encounter_events_combatant_ids');
      expect(MIGRATION_NAMES).toContain('0062_attachments_publication_state');
      expect(MIGRATION_NAMES).toContain('0063_comments_character_attribution');
      expect(MIGRATION_NAMES).toContain('0064_encounter_links_campaign_scope');
      expect(MIGRATION_NAMES).toContain('0065_notifications_comment_id');
      expect(MIGRATION_NAMES).toContain('0066_entity_revisions_version_authorship');
      expect(MIGRATION_NAMES).toContain('0067_campaign_members_exclusive_character');
      expect(MIGRATION_NAMES).toContain('0068_inventory_qty_idempotency');
      expect(MIGRATION_NAMES).toContain('0069_inventory_qty_idempotency_created_at');
      expect(MIGRATION_NAMES).toContain('0070_notifications_data');
      expect(MIGRATION_NAMES).toContain('0106_guest_dm_handoff_545');
      expect(MIGRATION_NAMES).toContain('0071_ai_dm_usage_history');
      expect(MIGRATION_NAMES).toContain('0085_combatants_condition_instances');
      expect(MIGRATION_NAMES).toContain('0086_encounters_boss_turn_phase');
      expect(MIGRATION_NAMES).toContain('0087_campaigns_narration_language');
      expect(MIGRATION_NAMES).toContain('0090_trash_soft_delete_701');
      expect(MIGRATION_NAMES).toContain('0149_ensure_soft_delete_columns_701');
      expect(MIGRATION_NAMES).toContain('0152_inventory_items_equip_1326');
      // Fresh DBs get the equip columns straight from BOOTSTRAP_SQL (issue #1326).
      expect(columnNames(sqlite, 'inventory_items')).toEqual(
        expect.arrayContaining(['equipped', 'equip_slot', 'equipped_action']),
      );
      expect(MIGRATION_NAMES).toContain('0095_campaign_catch_up_cursors');
      expect(MIGRATION_NAMES).toContain('0098_encounters_aftermath_dismissed');
      expect(MIGRATION_NAMES).toContain('0102_ai_scribe_session_scope_499');
      // #559: durable AI Driver control state is created as a NEW table on an old-shaped
      // DB, so pause/takeover/vote/stuck survive a restart after an in-place upgrade.
      expect(MIGRATION_NAMES).toContain('0118_ai_driver_control_state_559');
      expect(columnNames(sqlite, 'ai_driver_control_state')).toEqual(
        expect.arrayContaining([
          'campaign_id', 'status', 'state', 'scene', 'last_narration', 'last_turn_at',
          'turn_count', 'stuck', 'acting_dm', 'vote', 'takeover_requested_by', 'last_input',
          'announced_recovery', 'updated_at',
        ]),
      );
      expect(countRows(sqlite, 'ai_driver_control_state')).toBe(0);
      // Issue #585 — campaign module identity/lineage/baseline/snapshot tables.
      expect(MIGRATION_NAMES).toContain('0120_campaign_modules_585');
      for (const table of ['campaign_module_installs', 'campaign_module_artifacts', 'campaign_module_snapshots']) {
        expect(
          sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
        ).toBeTruthy();
      }
      expect(columnNames(sqlite, 'campaign_module_installs')).toEqual(
        expect.arrayContaining(['module_id', 'version', 'origin_kind', 'upstream_module_id', 'upstream_version', 'forked_at', 'detached']),
      );
      expect(columnNames(sqlite, 'campaign_module_artifacts')).toEqual(
        expect.arrayContaining(['artifact_key', 'entity_id', 'baseline_hash', 'baseline_json', 'overlay_json']),
      );
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_dm_usage_history'").get(),
      ).toBeTruthy();
      expect(
        (sqlite.pragma('index_list(ai_dm_usage_history)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_ai_dm_usage_history_campaign_created');
      expect(
        (sqlite.pragma('index_list(inventory_qty_idempotency)') as Array<{ name: string }>).map((index) => index.name),
      ).toEqual(expect.arrayContaining(['idx_inventory_qty_idempotency_item', 'idx_inventory_qty_idempotency_created']));
      expect(MIGRATION_NAMES).toContain('0076_campaign_purge_tombstones');
      expect(MIGRATION_NAMES).toContain('0083_users_time_format');
      expect(MIGRATION_NAMES).toContain('0084_hot_history_composite_indexes');
      expect(
        (sqlite.pragma('index_list(notes)') as Array<{ name: string }>).map((index) => index.name),
      ).toEqual(expect.arrayContaining(['idx_notes_campaign_id_desc', 'idx_notes_inbox_resolved']));
      expect(
        (sqlite.pragma('index_list(comments)') as Array<{ name: string }>).map((index) => index.name),
      ).toEqual(expect.arrayContaining(['idx_comments_entity', 'idx_comments_campaign_id']));
      expect(
        (sqlite.pragma('index_list(scheduled_sessions)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_scheduled_sessions_campaign_at');
      expect(
        (sqlite.pragma('index_list(timeline_events)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_timeline_events_campaign_sort');
      expect(
        (sqlite.pragma('index_list(dice_rolls)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_dice_rolls_campaign_id_desc');
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_purge_tombstones'").get(),
      ).toBeTruthy();
      expect(columnNames(sqlite, 'entity_revisions')).toEqual(
        expect.arrayContaining([
          'author_source',
          'author_source_detail',
          'replaced_by_user_id',
          'replaced_by_name',
          'replaced_by_source',
          'replaced_by_source_detail',
          'replaced_at',
          'restored_from_revision_id',
          'authorship_known',
        ]),
      );
      expect(
        (sqlite.pragma('index_list(campaign_members)') as Array<{ name: string }>).map((index) => index.name),
      ).toContain('idx_campaign_members_character');
      // Issue #744: the active-encounter pointer column is added to campaigns on old DBs too.
      expect(columnNames(sqlite, 'campaigns')).toEqual(expect.arrayContaining(['active_encounter_id']));
      expect(columnNames(sqlite, 'campaigns')).toEqual(expect.arrayContaining(['public_invites_enabled']));
      expect(columnNames(sqlite, 'comments')).toEqual(
        expect.arrayContaining(['character_id', 'character_name', 'character_avatar_url']),
      );

      // WAL mode is set on open.
      expect((sqlite.pragma('journal_mode', { simple: true }) as string).toLowerCase()).toBe('wal');
    } finally {
      sqlite.close();
    }
  });

  // ── schema-version table (issue #69) ────────────────────────────────────────

  it('records every applied migration in the __migrations version table', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir); // old-shaped DB with none of the migrations recorded yet.

    const { sqlite } = openDatabase(dataDir);
    try {
      // The version table exists and lists exactly the ordered migration registry —
      // every hand-rolled migrate* step is now a recorded, run-once operation.
      const recorded = (sqlite.prepare('SELECT name FROM __migrations ORDER BY name').all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(recorded).toEqual([...MIGRATION_NAMES].sort());
      // Each carries an applied_at timestamp (non-empty ISO string).
      const rows = sqlite.prepare('SELECT name, applied_at FROM __migrations').all() as Array<{ applied_at: string }>;
      expect(rows.every((r) => typeof r.applied_at === 'string' && r.applied_at.length > 0)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('does not re-run or duplicate recorded migrations on a second open', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const first = openDatabase(dataDir);
    const countAfterFirst = countRows(first.sqlite, '__migrations');
    first.sqlite.close();

    // A fresh DB records all of them too (each is a no-op — the tables don't exist
    // when it runs — but the bootstrap schema already includes what they'd add).
    expect(countAfterFirst).toBe(MIGRATION_NAMES.length);

    const second = openDatabase(dataDir);
    try {
      // Re-opening records nothing new (no duplicate rows, PRIMARY KEY on name).
      expect(countRows(second.sqlite, '__migrations')).toBe(countAfterFirst);
    } finally {
      second.sqlite.close();
    }
  });

  it('0121 creates ai_driver_grounding_claims identically on a fresh DB and an upgraded one (#577)', () => {
    // The classic failure for this convention is bootstrap.sql and the migration drifting apart,
    // leaving an upgraded install with a subtly different table than a fresh one. Assert the two
    // paths produce the SAME column set, and that the migration is registered + safely re-run.
    expect(MIGRATION_NAMES).toContain('0121_ai_driver_grounding_claims_577');

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
    ].sort();

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'ai_driver_grounding_claims');
        expect(
          (fresh.sqlite.pragma('index_list(ai_driver_grounding_claims)') as Array<{ name: string }>).map((i) => i.name),
        ).toContain('idx_ai_driver_grounding_campaign');
      } finally {
        fresh.sqlite.close();
      }

      writeOldSchemaDb(upgradedDir);
      const upgraded = openDatabase(upgradedDir);
      try {
        const upgradedCols = [...columnNames(upgraded.sqlite, 'ai_driver_grounding_claims')].sort();
        expect(upgradedCols).toEqual(expected);
        expect(upgradedCols).toEqual([...freshCols].sort());
        upgraded.sqlite
          .prepare(
            `INSERT INTO ai_driver_grounding_claims
               (campaign_id, turn, claim_index, kind, claim_text, status, reason, citations_json, provider, model, created_at)
             VALUES (1, 1, 0, 'rule', 'x', 'unsupported', 'not_retrieved', '[]', 'mock', 'm', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        expect(countRows(upgraded.sqlite, 'ai_driver_grounding_claims')).toBe(1);
      } finally {
        upgraded.sqlite.close();
      }

      // Re-opening must not drop or re-create the table (probe-before-act + run-once dedupe).
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'ai_driver_grounding_claims')).toBe(1);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0131 adds the AI-driver grant columns on a legacy control-state table (#1042)', () => {
    expect(MIGRATION_NAMES).toContain('0131_ai_driver_session_persistence_1042');
    // It must run AFTER 0118 creates the table — runMigrations executes in array order, and an
    // ALTER against a table that does not exist yet would be a no-op that never retries.
    expect(MIGRATION_NAMES.indexOf('0131_ai_driver_session_persistence_1042')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('0118_ai_driver_control_state_559'),
    );

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'ai_driver_control_state');
        expect(freshCols).toContain('secret_read_approvals');
        expect(freshCols).toContain('pending_tool_confirmations');
      } finally {
        fresh.sqlite.close();
      }

      // A database carrying #559's control-state table WITHOUT the new columns — the shape every
      // existing install has. A separate migration name is what makes this reachable at all: a
      // column folded into 0118 would never run here, because 0118 is already recorded.
      writeOldSchemaDb(upgradedDir);
      const seeded = openDatabase(upgradedDir);
      try {
        seeded.sqlite.exec('DROP TABLE IF EXISTS ai_driver_control_state');
        seeded.sqlite.exec(`
          CREATE TABLE ai_driver_control_state (
            campaign_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'idle',
            state TEXT NOT NULL DEFAULT 'running',
            scene TEXT, last_narration TEXT, last_turn_at TEXT,
            turn_count INTEGER NOT NULL DEFAULT 0,
            stuck TEXT, acting_dm TEXT, vote TEXT,
            takeover_requested_by TEXT, last_input TEXT, announced_recovery TEXT,
            updated_at TEXT NOT NULL
          );
        `);
        seeded.sqlite
          .prepare(
            `INSERT INTO ai_driver_control_state (campaign_id, status, state, updated_at)
             VALUES (1, 'paused', 'human_control', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        // All FOUR additive migrations on this table are un-recorded, not just the one under
        // test: the legacy CREATE above predates every one of them, and the fresh-vs-upgraded
        // column comparison below only holds if all of them re-run against the legacy shape.
        // Un-recording only one leaves a sibling's column missing and fails the comparison for a
        // reason that has nothing to do with what this test is actually checking.
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0131_ai_driver_session_persistence_1042');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0133_ai_session_phase_1043');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0138_ai_collaborative_handoff_1051');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0153_ai_driver_aftermath_grant_window_1781');
      } finally {
        seeded.sqlite.close();
      }

      const upgraded = openDatabase(upgradedDir);
      try {
        const cols = columnNames(upgraded.sqlite, 'ai_driver_control_state');
        expect(cols).toContain('secret_read_approvals');
        expect(cols).toContain('pending_tool_confirmations');
        expect([...cols].sort()).toEqual([...freshCols].sort());
        // ADD COLUMN, never a rebuild: the existing takeover grant is still there. Losing a row
        // to "fix" its shape would recreate the exact silent-revocation bug #1042 is about.
        const row = upgraded.sqlite
          .prepare('SELECT state, secret_read_approvals FROM ai_driver_control_state WHERE campaign_id = 1')
          .get() as { state: string; secret_read_approvals: string | null } | undefined;
        expect(row?.state).toBe('human_control');
        expect(row?.secret_read_approvals).toBeNull();
      } finally {
        upgraded.sqlite.close();
      }

      // Re-running is a no-op (the per-column PRAGMA probe), not a duplicate-column error.
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'ai_driver_control_state')).toBe(1);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0126 adds campaigns.catalog_privacy and campaign_export_requests on both paths (#587)', () => {
    // Same fresh-vs-upgraded parity contract as 0121 above, but this migration has TWO
    // halves — an ADD COLUMN on an existing table and a brand-new table — so both are
    // checked, plus the default backfill that decides what an un-migrated campaign's
    // catalog privacy means.
    expect(MIGRATION_NAMES).toContain('0126_admin_campaign_catalog_587');

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
    ].sort();

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'campaign_export_requests');
        expect(columnNames(fresh.sqlite, 'campaigns')).toContain('catalog_privacy');
        expect(
          (fresh.sqlite.pragma('index_list(campaign_export_requests)') as Array<{ name: string }>).map((i) => i.name),
        ).toEqual(
          expect.arrayContaining([
            'idx_campaign_export_requests_campaign',
            'idx_campaign_export_requests_status',
          ]),
        );
      } finally {
        fresh.sqlite.close();
      }

      writeOldSchemaDb(upgradedDir);
      const upgraded = openDatabase(upgradedDir);
      try {
        const upgradedCols = [...columnNames(upgraded.sqlite, 'campaign_export_requests')].sort();
        expect(upgradedCols).toEqual(expected);
        expect(upgradedCols).toEqual([...freshCols].sort());
        expect(columnNames(upgraded.sqlite, 'campaigns')).toContain('catalog_privacy');

        // The seeded legacy campaign predates the column; the NOT NULL DEFAULT must have
        // backfilled it to 'inherit' rather than leaving a NULL that would read as an
        // opt-out (or fail the enum on the way out).
        const backfilled = upgraded.sqlite
          .prepare('SELECT catalog_privacy FROM campaigns')
          .all() as Array<{ catalog_privacy: string }>;
        expect(backfilled.length).toBeGreaterThan(0);
        for (const row of backfilled) expect(row.catalog_privacy).toBe('inherit');

        upgraded.sqlite
          .prepare(
            `INSERT INTO campaign_export_requests
               (campaign_id, requested_by, requested_by_user_id, profile, justification, status, decision_note, created_at, updated_at)
             VALUES (1, '1', '1', 'backup', 'season rollover', 'pending', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        expect(countRows(upgraded.sqlite, 'campaign_export_requests')).toBe(1);
      } finally {
        upgraded.sqlite.close();
      }

      // Re-opening must not drop or re-create the table, nor re-run the ADD COLUMN
      // (probe-before-act + run-once dedupe on the full migration name).
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'campaign_export_requests')).toBe(1);
        expect(columnNames(again.sqlite, 'campaigns')).toContain('catalog_privacy');
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0127 creates the session-zero consent tables identically on fresh and upgraded DBs (#600)', () => {
    expect(MIGRATION_NAMES).toContain('0127_session_zero_consent_600');

    const expected = {
      session_zero_charter_versions: [
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
      ].sort(),
      session_zero_acknowledgments: [
        'id',
        'campaign_id',
        'version_id',
        'user_id',
        'user_name',
        'state',
        'note',
        'created_at',
        'updated_at',
      ].sort(),
      session_zero_boundary_submissions: [
        'id',
        'campaign_id',
        'kind',
        'text',
        'anonymous',
        'submitter_user_id',
        'submitter_name',
        'created_at',
        'updated_at',
      ].sort(),
      session_zero_guardian_consents: [
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
      ].sort(),
    };

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      const freshCols: Record<string, string[]> = {};
      try {
        for (const table of Object.keys(expected)) {
          freshCols[table] = [...columnNames(fresh.sqlite, table)].sort();
        }
        expect(columnNames(fresh.sqlite, 'session_zero')).toContain('preview_policy');
      } finally {
        fresh.sqlite.close();
      }

      writeOldSchemaDb(upgradedDir);
      const upgraded = openDatabase(upgradedDir);
      try {
        for (const [table, cols] of Object.entries(expected)) {
          const upgradedCols = [...columnNames(upgraded.sqlite, table)].sort();
          expect(upgradedCols).toEqual(cols);
          // Fresh and upgraded must agree — the classic failure for this convention is
          // bootstrap.sql and the migration drifting apart.
          expect(upgradedCols).toEqual(freshCols[table]);
        }

        // The ADD COLUMN backfills the conservative value rather than leaving NULL,
        // which would read as "no policy" and fail the enum on the way out.
        expect(columnNames(upgraded.sqlite, 'session_zero')).toContain('preview_policy');
        const policies = upgraded.sqlite
          .prepare('SELECT preview_policy FROM session_zero')
          .all() as Array<{ preview_policy: string }>;
        for (const row of policies) expect(row.preview_policy).toBe('boundaries');

        // The guardian table must carry NO age identifier on the upgraded path either —
        // the requirement is that the column never exists, not that the API declines to
        // populate it.
        const guardianCols = columnNames(upgraded.sqlite, 'session_zero_guardian_consents');
        expect(guardianCols.filter((c) => /birth|dob|age|year/i.test(c))).toEqual([]);

        upgraded.sqlite
          .prepare(
            `INSERT INTO session_zero_charter_versions
               (campaign_id, version, lines, veils, safety_tools, house_rules, tone_and_expectations, material, change_summary, published_by, published_at)
             VALUES (1, 1, '[]', '[]', '[]', '', '', 0, '', '1', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        expect(countRows(upgraded.sqlite, 'session_zero_charter_versions')).toBe(1);
      } finally {
        upgraded.sqlite.close();
      }

      // Re-opening must not drop or recreate anything (probe-before-act + name dedupe).
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'session_zero_charter_versions')).toBe(1);
        expect(columnNames(again.sqlite, 'session_zero')).toContain('preview_policy');
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0129 creates ai_driver_withheld_turns identically on a fresh DB and an upgraded one (#598)', () => {
    // Same convention check as 0121: bootstrap.sql and the migration drifting apart would leave
    // an upgraded install with a subtly different table than a fresh one.
    expect(MIGRATION_NAMES).toContain('0129_ai_driver_withheld_turns_598');

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
    ].sort();

    // The privacy contract is part of the SCHEMA, not just of the code that writes it: there
    // must be no column capable of holding the withheld prose, nor a digest of it. A future
    // "just add a text column so a DM can review what was blocked" would recreate the exposure
    // in a longer-lived, exportable place than the live stream it was kept off — so it fails here.
    expect(expected.filter((c) => /text|body|content|prose|excerpt|narration|hash|digest/.test(c))).toEqual([]);

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'ai_driver_withheld_turns');
        expect(
          (fresh.sqlite.pragma('index_list(ai_driver_withheld_turns)') as Array<{ name: string }>).map((i) => i.name),
        ).toContain('idx_ai_driver_withheld_campaign');
      } finally {
        fresh.sqlite.close();
      }

      writeOldSchemaDb(upgradedDir);
      const upgraded = openDatabase(upgradedDir);
      try {
        const upgradedCols = [...columnNames(upgraded.sqlite, 'ai_driver_withheld_turns')].sort();
        expect(upgradedCols).toEqual(expected);
        expect(upgradedCols).toEqual([...freshCols].sort());
        upgraded.sqlite
          .prepare(
            `INSERT INTO ai_driver_withheld_turns
               (campaign_id, turn, step, finish_reason, provider, model, withheld_chars, released_chars,
                suppressed_tool_calls, triggered_by_user_id, created_at)
             VALUES (1, 3, 1, 'content_filter', 'mock', 'm', 412, 0, 1, 'dev:1', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        expect(countRows(upgraded.sqlite, 'ai_driver_withheld_turns')).toBe(1);
      } finally {
        upgraded.sqlite.close();
      }

      // Re-opening must not drop or re-create the table (probe-before-act + run-once dedupe).
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'ai_driver_withheld_turns')).toBe(1);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0152 adds #842 safety attribution identically on a fresh DB and an upgraded one', () => {
    // Same drift guard as 0121: bootstrap.sql and the migration must produce the SAME table, or
    // an upgraded install ends up with a subtly different safety-hold row than a fresh one.
    expect(MIGRATION_NAMES).toContain('0130_table_safety_holds_599');
    expect(MIGRATION_NAMES).toContain('0152_table_safety_attribution_842');

    const expected = [
      'campaign_id',
      'active',
      'activated_at',
      'activated_by_name',
      'anonymous',
      'activation_count',
      'released_at',
      'released_by',
      'released_by_user_id',
      'recovery',
      'facilitator_note',
      'updated_at',
    ].sort();

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'table_safety_holds');
        expect([...freshCols].sort()).toEqual(expected);
        expect(freshCols).not.toContain('activated_by_user_id');
        expect(freshCols).toContain('released_by_user_id');
      } finally {
        fresh.sqlite.close();
      }

      // A partially repaired legacy install can have recorded #599 but no longer
      // have its table. #842 must skip its ALTER in that state; bootstrap then
      // recreates the current table shape instead of aborting startup.
      const missingTable = new Database(dbFilePath(dataDir));
      try {
        missingTable.exec('DROP TABLE table_safety_holds');
        missingTable.prepare('DELETE FROM __migrations WHERE name = ?').run('0152_table_safety_attribution_842');
      } finally {
        missingTable.close();
      }
      const recreated = openDatabase(dataDir);
      try {
        expect([...columnNames(recreated.sqlite, 'table_safety_holds')].sort()).toEqual(expected);
        expect(
          recreated.sqlite.prepare('SELECT name FROM __migrations WHERE name = ?').get('0152_table_safety_attribution_842'),
        ).toEqual({ name: '0152_table_safety_attribution_842' });
      } finally {
        recreated.sqlite.close();
      }

      writeOldSchemaDb(upgradedDir);
      const upgraded = openDatabase(upgradedDir);
      try {
        const upgradedCols = [...columnNames(upgraded.sqlite, 'table_safety_holds')].sort();
        expect(upgradedCols).toEqual(expected);
        expect(upgradedCols).toEqual([...freshCols].sort());
        upgraded.sqlite
          .prepare(
            `INSERT INTO table_safety_holds
               (campaign_id, active, activated_at, anonymous, activation_count, updated_at)
             VALUES (1, 1, '2026-01-01T00:00:00.000Z', 1, 1, '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        expect(countRows(upgraded.sqlite, 'table_safety_holds')).toBe(1);
        expect(
          upgraded.sqlite
            .prepare('SELECT released_by_user_id FROM table_safety_holds WHERE campaign_id = 1')
            .get(),
        ).toEqual({ released_by_user_id: null });
      } finally {
        upgraded.sqlite.close();
      }

      // A restart must not drop the row: an un-paused table is exactly what a safety hold
      // surviving a deploy is supposed to prevent.
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'table_safety_holds')).toBe(1);
        const row = again.sqlite.prepare('SELECT active FROM table_safety_holds WHERE campaign_id = 1').get() as
          | { active: number }
          | undefined;
        expect(row?.active).toBe(1);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0153 adds explicit imported-attribution markers with privacy-safe legacy defaults (#842)', () => {
    expect(MIGRATION_NAMES).toContain('0153_imported_attribution_842');
    dataDir = makeTempDataDir();
    const fresh = openDatabase(dataDir);
    fresh.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec(`
        ALTER TABLE notes DROP COLUMN author_imported;
        ALTER TABLE comments DROP COLUMN author_imported;
        ALTER TABLE session_rsvps DROP COLUMN user_imported;
        ALTER TABLE entity_revisions DROP COLUMN author_imported;
        ALTER TABLE entity_revisions DROP COLUMN replaced_by_imported;
      `);
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0153_imported_attribution_842');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'notes')).toContain('author_imported');
      expect(columnNames(upgraded.sqlite, 'comments')).toContain('author_imported');
      expect(columnNames(upgraded.sqlite, 'session_rsvps')).toContain('user_imported');
      expect(columnNames(upgraded.sqlite, 'entity_revisions')).toEqual(
        expect.arrayContaining(['author_imported', 'replaced_by_imported']),
      );
      for (const [table, column] of [
        ['notes', 'author_imported'],
        ['comments', 'author_imported'],
        ['session_rsvps', 'user_imported'],
        ['entity_revisions', 'author_imported'],
        ['entity_revisions', 'replaced_by_imported'],
      ]) {
        const info = (upgraded.sqlite.pragma(`table_info(${table})`) as Array<{ name: string; dflt_value: string | null }>)
          .find((entry) => entry.name === column);
        expect(info?.dflt_value).toBe('0');
      }
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('0154 adds session-share creator IDs on upgrade and skips a missing legacy table (#842)', () => {
    expect(MIGRATION_NAMES).toContain('0154_session_shares_creator_842');
    dataDir = makeTempDataDir();
    const fresh = openDatabase(dataDir);
    try {
      expect(columnNames(fresh.sqlite, 'session_shares')).toContain('created_by_user_id');
    } finally {
      fresh.sqlite.close();
    }

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec('ALTER TABLE session_shares DROP COLUMN created_by_user_id');
      legacy.pragma('foreign_keys = OFF'); // the fixture needs only the retained creator copy, not its parents
      legacy
        .prepare(
          `INSERT INTO session_shares
             (session_id, campaign_id, label, created_by, token_hash, token_prefix, expires_at, access_count, first_accessed_at, last_accessed_at, created_at, updated_at)
           VALUES (1, 1, 'legacy share', 'Legacy creator', 'legacy-share-hash', 'cf_share_leg', NULL, 0, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0154_session_shares_creator_842');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'session_shares')).toContain('created_by_user_id');
      const info = (upgraded.sqlite.pragma('table_info(session_shares)') as Array<{ name: string; notnull: number }>)
        .find((entry) => entry.name === 'created_by_user_id');
      expect(info).toMatchObject({ notnull: 0 });
      expect(
        upgraded.sqlite.prepare(`SELECT created_by, created_by_user_id FROM session_shares WHERE token_hash = 'legacy-share-hash'`).get(),
      ).toEqual({ created_by: 'Legacy creator', created_by_user_id: null });
    } finally {
      upgraded.sqlite.close();
    }

    const missing = new Database(dbFilePath(dataDir));
    try {
      missing.exec('DROP TABLE session_shares');
      missing.prepare('DELETE FROM __migrations WHERE name = ?').run('0154_session_shares_creator_842');
    } finally {
      missing.close();
    }
    expect(() => openDatabase(dataDir).sqlite.close()).not.toThrow();
  });

  it('0155 adds cast-session creator IDs on upgrade and skips a missing legacy table (#842)', () => {
    expect(MIGRATION_NAMES).toContain('0155_cast_sessions_creator_842');
    dataDir = makeTempDataDir();
    const fresh = openDatabase(dataDir);
    try {
      expect(columnNames(fresh.sqlite, 'cast_sessions')).toContain('created_by_user_id');
    } finally {
      fresh.sqlite.close();
    }

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec('ALTER TABLE cast_sessions DROP COLUMN created_by_user_id');
      legacy.pragma('foreign_keys = OFF'); // the fixture needs only the retained creator copy, not its parent
      legacy
        .prepare(
          `INSERT INTO cast_sessions
             (campaign_id, label, created_by, token_hash, token_prefix, exit_pin_hash, expires_at, access_count, first_accessed_at, last_accessed_at, created_at, updated_at)
           VALUES (1, 'legacy cast', 'Legacy creator', 'legacy-cast-hash', 'cf_cast_leg', 'legacy-pin-hash', '2027-01-01T00:00:00.000Z', 0, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0155_cast_sessions_creator_842');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'cast_sessions')).toContain('created_by_user_id');
      const info = (upgraded.sqlite.pragma('table_info(cast_sessions)') as Array<{ name: string; notnull: number }>)
        .find((entry) => entry.name === 'created_by_user_id');
      expect(info).toMatchObject({ notnull: 0 });
      expect(
        upgraded.sqlite.prepare(`SELECT created_by, created_by_user_id FROM cast_sessions WHERE token_hash = 'legacy-cast-hash'`).get(),
      ).toEqual({ created_by: 'Legacy creator', created_by_user_id: null });
    } finally {
      upgraded.sqlite.close();
    }

    const missing = new Database(dbFilePath(dataDir));
    try {
      missing.exec('DROP TABLE cast_sessions');
      missing.prepare('DELETE FROM __migrations WHERE name = ?').run('0155_cast_sessions_creator_842');
    } finally {
      missing.close();
    }
    expect(() => openDatabase(dataDir).sqlite.close()).not.toThrow();
  });

  it('0133 backfills ai_driver_control_state.phase on a legacy table (#1043)', () => {
    expect(MIGRATION_NAMES).toContain('0133_ai_session_phase_1043');
    // ALTERs the table 0118 creates, so it must run after it — runMigrations goes in array order
    // and an ALTER against a missing table is a no-op that never retries.
    expect(MIGRATION_NAMES.indexOf('0133_ai_session_phase_1043')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('0118_ai_driver_control_state_559'),
    );

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'ai_driver_control_state');
        expect(freshCols).toContain('phase');
      } finally {
        fresh.sqlite.close();
      }

      // The shape every existing install has: #559's control-state table, none of the additive
      // columns, and live rows in it.
      writeOldSchemaDb(upgradedDir);
      const seeded = openDatabase(upgradedDir);
      try {
        seeded.sqlite.exec('DROP TABLE IF EXISTS ai_driver_control_state');
        seeded.sqlite.exec(`
          CREATE TABLE ai_driver_control_state (
            campaign_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'idle',
            state TEXT NOT NULL DEFAULT 'running',
            scene TEXT, last_narration TEXT, last_turn_at TEXT,
            turn_count INTEGER NOT NULL DEFAULT 0,
            stuck TEXT, acting_dm TEXT, vote TEXT,
            takeover_requested_by TEXT, last_input TEXT, announced_recovery TEXT,
            updated_at TEXT NOT NULL
          );
        `);
        seeded.sqlite
          .prepare(
            `INSERT INTO ai_driver_control_state (campaign_id, status, state, updated_at)
             VALUES (1, 'paused', 'human_control', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        // All THREE additive migrations on this table are un-recorded, not just the one under
        // test: the legacy CREATE above predates every one of them, and the fresh-vs-upgraded
        // column comparison below only holds if all of them re-run against the legacy shape.
        // Un-recording only one leaves a sibling's column missing and fails the comparison for a
        // reason that has nothing to do with what this test is actually checking.
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0131_ai_driver_session_persistence_1042');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0133_ai_session_phase_1043');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0138_ai_collaborative_handoff_1051');
      } finally {
        seeded.sqlite.close();
      }

      const upgraded = openDatabase(upgradedDir);
      try {
        expect([...columnNames(upgraded.sqlite, 'ai_driver_control_state')].sort()).toEqual([...freshCols].sort());
        const row = upgraded.sqlite
          .prepare('SELECT state, phase FROM ai_driver_control_state WHERE campaign_id = 1')
          .get() as { state: string; phase: string } | undefined;
        // NOT NULL + DEFAULT is what makes the ALTER safe on a populated table: SQLite backfills
        // every existing row with 'active', whose behaviour is identical to the pre-#1043 seat.
        // An upgraded install with live sessions therefore wakes up exactly as it went to sleep,
        // rather than every campaign in the database landing in a lifecycle phase nobody chose.
        expect(row?.phase).toBe('active');
        // ADD COLUMN, never a rebuild — the existing takeover grant is untouched.
        expect(row?.state).toBe('human_control');
      } finally {
        upgraded.sqlite.close();
      }

      // Re-running is a no-op (the PRAGMA probe), not a duplicate-column error.
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'ai_driver_control_state')).toBe(1);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0138 backfills ai_driver_control_state.collaborative on a legacy table (#1051)', () => {
    expect(MIGRATION_NAMES).toContain('0138_ai_collaborative_handoff_1051');
    // ALTERs the table 0118 creates, so it must run after it — runMigrations goes in array order
    // and an ALTER against a missing table is a no-op that never retries.
    expect(MIGRATION_NAMES.indexOf('0138_ai_collaborative_handoff_1051')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('0118_ai_driver_control_state_559'),
    );

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshCols: string[];
      try {
        freshCols = columnNames(fresh.sqlite, 'ai_driver_control_state');
        expect(freshCols).toContain('collaborative');
      } finally {
        fresh.sqlite.close();
      }

      // The shape every existing install has: #559's control-state table, none of the additive
      // columns, and live rows in it.
      writeOldSchemaDb(upgradedDir);
      const seeded = openDatabase(upgradedDir);
      try {
        seeded.sqlite.exec('DROP TABLE IF EXISTS ai_driver_control_state');
        seeded.sqlite.exec(`
          CREATE TABLE ai_driver_control_state (
            campaign_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'idle',
            state TEXT NOT NULL DEFAULT 'running',
            scene TEXT, last_narration TEXT, last_turn_at TEXT,
            turn_count INTEGER NOT NULL DEFAULT 0,
            stuck TEXT, acting_dm TEXT, vote TEXT,
            takeover_requested_by TEXT, last_input TEXT, announced_recovery TEXT,
            updated_at TEXT NOT NULL
          );
        `);
        seeded.sqlite
          .prepare(
            `INSERT INTO ai_driver_control_state (campaign_id, status, state, updated_at)
             VALUES (1, 'paused', 'human_control', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        // All THREE additive migrations on this table are un-recorded, not just the one under
        // test: the legacy CREATE above predates every one of them, and the fresh-vs-upgraded
        // column comparison below only holds if all of them re-run against the legacy shape.
        // Un-recording only one leaves a sibling's column missing and fails the comparison for a
        // reason that has nothing to do with what this test is actually checking.
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0131_ai_driver_session_persistence_1042');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0133_ai_session_phase_1043');
        seeded.sqlite.prepare('DELETE FROM __migrations WHERE name = ?').run('0138_ai_collaborative_handoff_1051');
      } finally {
        seeded.sqlite.close();
      }

      const upgraded = openDatabase(upgradedDir);
      try {
        expect([...columnNames(upgraded.sqlite, 'ai_driver_control_state')].sort()).toEqual([...freshCols].sort());
        const row = upgraded.sqlite
          .prepare('SELECT state, collaborative FROM ai_driver_control_state WHERE campaign_id = 1')
          .get() as { state: string; collaborative: number } | undefined;
        // NOT NULL DEFAULT 0 backfills every existing row to "off", which is the behaviour every
        // campaign already has. An upgraded install cannot wake up with the AI unexpectedly
        // deferring — or, worse, unexpectedly not deferring.
        expect(row?.collaborative).toBe(0);
        // ADD COLUMN, never a rebuild — the existing takeover grant is untouched.
        expect(row?.state).toBe('human_control');
      } finally {
        upgraded.sqlite.close();
      }

      // Re-running is a no-op (the PRAGMA probe), not a duplicate-column error.
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'ai_driver_control_state')).toBe(1);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0135 adds ai_provider_configs.role and WIDENS the partial uniques so a fallback can exist (#1052)', () => {
    expect(MIGRATION_NAMES).toContain('0135_ai_provider_config_fallback_role_1052');

    const upgradedDir = makeTempDataDir();
    dataDir = makeTempDataDir();
    try {
      const fresh = openDatabase(dataDir);
      let freshIndexes: string[];
      try {
        expect(columnNames(fresh.sqlite, 'ai_provider_configs')).toContain('role');
        freshIndexes = (
          fresh.sqlite.pragma('index_list(ai_provider_configs)') as Array<{ name: string }>
        ).map((i) => i.name);
      } finally {
        fresh.sqlite.close();
      }

      writeOldSchemaDb(upgradedDir);
      const upgraded = openDatabase(upgradedDir);
      try {
        expect(columnNames(upgraded.sqlite, 'ai_provider_configs')).toContain('role');

        // The OLD one-row-per-scope indexes must be GONE, not merely shadowed. Leaving them
        // would make the fallback insert below fail on an upgraded install while succeeding on
        // a fresh one — the exact fresh/upgraded divergence this whole convention guards.
        const upgradedIndexes = (
          upgraded.sqlite.pragma('index_list(ai_provider_configs)') as Array<{ name: string }>
        ).map((i) => i.name);
        expect(upgradedIndexes).toContain('idx_ai_provider_configs_server_role');
        expect(upgradedIndexes).toContain('idx_ai_provider_configs_campaign_role');
        expect(upgradedIndexes).not.toContain('idx_ai_provider_configs_server');
        expect(upgradedIndexes).not.toContain('idx_ai_provider_configs_campaign');
        expect([...upgradedIndexes].sort()).toEqual([...freshIndexes].sort());

        const insert = upgraded.sqlite.prepare(
          `INSERT INTO ai_provider_configs (scope, campaign_id, provider_type, model, role, created_at, updated_at)
           VALUES (?, ?, 'openai', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        );
        // One primary AND one fallback at the server scope — impossible before this migration.
        insert.run('server', null, 'primary-model', 'primary');
        insert.run('server', null, 'fallback-model', 'fallback');
        expect(countRows(upgraded.sqlite, 'ai_provider_configs')).toBe(2);

        // ...but still at most ONE of each. Widening the uniqueness must not remove it.
        expect(() => insert.run('server', null, 'another', 'primary')).toThrow(/UNIQUE/i);
      } finally {
        upgraded.sqlite.close();
      }

      // Re-opening must be a no-op: the column probe and DROP INDEX IF EXISTS are idempotent,
      // and the rows written above must survive.
      const again = openDatabase(upgradedDir);
      try {
        expect(countRows(again.sqlite, 'ai_provider_configs')).toBe(2);
      } finally {
        again.sqlite.close();
      }
    } finally {
      fs.rmSync(upgradedDir, { recursive: true, force: true });
    }
  });

  it('0070 adds notifications.data on a legacy table and preserves JSON payloads', () => {
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      const now = '2026-07-22T00:00:00.000Z';
      legacy.prepare(
        "INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (1, 'legacy-notif-dm', 'Legacy Notif DM', 'hash', 'user', 0, ?, ?)",
      ).run(now, now);
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Legacy Notif Campaign', ?, ?)").run(now, now);
      legacy.exec(`
        DROP TABLE notifications;
        CREATE TABLE notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          campaign_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          entity_type TEXT,
          entity_id INTEGER,
          comment_id INTEGER,
          actor_name TEXT NOT NULL DEFAULT '',
          read_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      legacy
        .prepare(
          "INSERT INTO notifications (id, user_id, campaign_id, type, title, body, entity_type, entity_id, actor_name, created_at) VALUES (1, 1, 1, 'schedule', 'Game night was scheduled', 'Starts at 2026-07-22T00:00:00.000Z', 'schedule', 11, 'DM', ?)",
        )
        .run(now);
      legacy.prepare("DELETE FROM __migrations WHERE name = '0070_notifications_data'").run();
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'notifications')).toEqual(expect.arrayContaining(['data']));
      const payload = JSON.stringify({
        kind: 'schedule',
        scheduleId: 11,
        scheduledAt: '2026-07-22T00:00:00.000Z',
        durationMinutes: 240,
        changeType: 'created',
        changedFields: [],
        label: 'Game night',
      });
      upgraded.sqlite.prepare('UPDATE notifications SET data = ? WHERE id = 1').run(payload);
      const row = upgraded.sqlite.prepare('SELECT data, title FROM notifications WHERE id = 1').get() as {
        data: string;
        title: string;
      };
      expect(row.title).toBe('Game night was scheduled');
      expect(JSON.parse(row.data)).toMatchObject({ kind: 'schedule', scheduleId: 11, changeType: 'created' });
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('0052 upgrades legacy recap shares with a seven-day sunset and audit metadata columns', () => {
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      const now = '2026-07-22T00:00:00.000Z';
      legacy.prepare("INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (1, 'legacy-share-dm', 'Legacy Share DM', 'hash', 'user', 0, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Legacy Share Campaign', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO sessions (id, campaign_id, number, created_at, updated_at) VALUES (1, 1, 1, ?, ?)").run(now, now);
      legacy.exec(`
        DROP TABLE session_shares;
        CREATE TABLE session_shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          campaign_id INTEGER NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          token_hash TEXT NOT NULL UNIQUE,
          token_prefix TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacy.prepare('INSERT INTO session_shares VALUES (1, 1, 1, ?, ?, ?, ?, ?)').run('1', 'legacy-token-hash', 'cf_share_abcd', now, now);
      legacy.prepare("DELETE FROM __migrations WHERE name = '0052_public_recap_share_policy'").run();
    } finally {
      legacy.close();
    }

    const beforeUpgrade = Date.now();
    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'session_shares')).toEqual(
        expect.arrayContaining(['label', 'expires_at', 'access_count', 'first_accessed_at', 'last_accessed_at']),
      );
      const row = upgraded.sqlite.prepare('SELECT * FROM session_shares WHERE id = 1').get() as Record<string, unknown>;
      expect(row).toMatchObject({ label: '', access_count: 0, created_by: 'Legacy Share DM' });
      const expiry = Date.parse(String(row.expires_at));
      expect(expiry).toBeGreaterThanOrEqual(beforeUpgrade + 6 * 24 * 60 * 60 * 1000);
      expect(expiry).toBeLessThanOrEqual(beforeUpgrade + 8 * 24 * 60 * 60 * 1000);
    } finally {
      upgraded.sqlite.close();
    }
  });

  // ── foreign-key enforcement on FRESH DBs (issue #69) ────────────────────────

  it('enforces foreign keys on a fresh DB and CASCADEs children on a campaign delete', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      // Enforcement is turned on by openDatabase.
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

      const now = '2026-01-01T00:00:00.000Z';
      sqlite.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'FK Camp', ?, ?)").run(now, now);
      sqlite
        .prepare("INSERT INTO characters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Hero', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO encounters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Fight', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO combatants (id, encounter_id, character_id, kind, name) VALUES (1, 1, 1, 'pc', 'Hero')")
        .run();
      sqlite.prepare("INSERT INTO quests (id, campaign_id, title, created_at, updated_at) VALUES (1, 1, 'Q', ?, ?)").run(now, now);
      sqlite.prepare("INSERT INTO quest_objectives (id, quest_id, text) VALUES (1, 1, 'do it')").run();

      // Deleting the campaign ROW alone — no manual child deletes — must cascade to
      // every strict child AND the two-hop children (combatants off encounters,
      // quest_objectives off quests). This proves the constraints, not the service.
      sqlite.prepare('DELETE FROM campaigns WHERE id = 1').run();

      expect(countRows(sqlite, 'characters')).toBe(0);
      expect(countRows(sqlite, 'encounters')).toBe(0);
      expect(countRows(sqlite, 'combatants')).toBe(0);
      expect(countRows(sqlite, 'quests')).toBe(0);
      expect(countRows(sqlite, 'quest_objectives')).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('SET NULLs a soft reference (combatant.character_id) when a character is deleted', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      sqlite
        .prepare("INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES (7, 'fk-player', '', 'hash', ?, ?)")
        .run(now, now);
      sqlite.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'FK Camp', ?, ?)").run(now, now);
      sqlite
        .prepare("INSERT INTO characters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Hero', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO encounters (id, campaign_id, name, created_at, updated_at) VALUES (1, 1, 'Fight', ?, ?)")
        .run(now, now);
      sqlite
        .prepare("INSERT INTO combatants (id, encounter_id, character_id, kind, name) VALUES (1, 1, 1, 'pc', 'Hero')")
        .run();
      sqlite
        .prepare('INSERT INTO campaign_members (id, campaign_id, user_id, role, character_id, created_at, updated_at) VALUES (1, 1, 7, \'player\', 1, ?, ?)')
        .run(now, now);

      // Deleting the character must NOT delete the combatant / member — their soft
      // link is nulled and the rows stay (no dangling reference to a ghost id).
      sqlite.prepare('DELETE FROM characters WHERE id = 1').run();

      expect(countRows(sqlite, 'combatants')).toBe(1);
      expect((sqlite.prepare('SELECT character_id FROM combatants WHERE id = 1').get() as { character_id: unknown }).character_id).toBeNull();
      expect(countRows(sqlite, 'campaign_members')).toBe(1);
      expect((sqlite.prepare('SELECT character_id FROM campaign_members WHERE id = 1').get() as { character_id: unknown }).character_id).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('rejects an insert that violates a foreign key on a fresh DB', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      // A character referencing a non-existent campaign must be rejected outright —
      // enforcement is genuinely ON, not merely declared.
      expect(() =>
        sqlite
          .prepare("INSERT INTO characters (campaign_id, name, created_at, updated_at) VALUES (999, 'Orphan', '', '')")
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      sqlite.close();
    }
  });

  it('0046 removes ghost memberships, records safe repair metadata, and enforces the user FK on upgrade', () => {
    dataDir = makeTempDataDir();

    // Start with the complete current schema, then replace campaign_members with
    // its legacy unconstrained shape and mark 0046 unapplied. This isolates the
    // real production upgrade path without hand-maintaining every unrelated table.
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();
    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      const now = '2026-07-22T00:00:00.000Z';
      legacy.prepare("INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (1, 'real-dm', 'Real DM', 'hash', 'user', 0, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO users (id, username, display_name, password_hash, server_role, disabled, created_at, updated_at) VALUES (2, 'linked-player', 'Linked Player', 'hash', 'user', 0, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Legacy Ghost Campaign', ?, ?)").run(now, now);
      legacy.exec(`
        DROP TABLE campaign_members;
        CREATE TABLE campaign_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          character_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(campaign_id, user_id)
        );
      `);
      legacy.prepare("INSERT INTO campaign_members VALUES (1, 1, 1, 'dm', NULL, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaign_members VALUES (2, 1, 999999, 'dm', NULL, ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaign_members VALUES (3, 1, 2, 'player', 888888, ?, ?)").run(now, now);
      legacy.prepare("DELETE FROM __migrations WHERE name = '0046_campaign_members_user_fk'").run();
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      const memberships = upgraded.sqlite
        .prepare('SELECT id, user_id, role, character_id FROM campaign_members ORDER BY id')
        .all();
      expect(memberships).toEqual([
        { id: 1, user_id: 1, role: 'dm', character_id: null },
        { id: 3, user_id: 2, role: 'player', character_id: null },
      ]);

      const repairs = upgraded.sqlite
        .prepare('SELECT member_id, user_id, reason, action, invalid_reference_id FROM membership_integrity_repairs ORDER BY member_id')
        .all();
      expect(repairs).toEqual([
        { member_id: 2, user_id: 999999, reason: 'missing_user', action: 'removed_membership', invalid_reference_id: 999999 },
        { member_id: 3, user_id: 2, reason: 'missing_character', action: 'cleared_character', invalid_reference_id: 888888 },
      ]);

      const fks = upgraded.sqlite.pragma('foreign_key_list(campaign_members)') as Array<{ table: string; from: string; on_delete: string }>;
      expect(fks).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'users', from: 'user_id', on_delete: 'CASCADE' }),
      ]));
      expect(() =>
        upgraded.sqlite
          .prepare("INSERT INTO campaign_members (campaign_id, user_id, role, created_at, updated_at) VALUES (1, 123456, 'player', '', '')")
          .run(),
      ).toThrow(/FOREIGN KEY/i);

      upgraded.sqlite.prepare('DELETE FROM users WHERE id = 2').run();
      expect(
        (upgraded.sqlite.prepare('SELECT COUNT(*) AS n FROM campaign_members WHERE user_id = 2').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('0059 nullifies cross-campaign encounter links and preserves valid ones (issue #864)', () => {
    dataDir = makeTempDataDir();

    // Seed a fully-migrated DB, plant a cross-campaign encounter link (SQLite FKs
    // only check the target row exists — not campaign_id match), then re-run 0059.
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();
    const legacy = new Database(dbFilePath(dataDir));
    try {
      const now = '2026-07-23T00:00:00.000Z';
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (1, 'Camp A', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO campaigns (id, name, created_at, updated_at) VALUES (2, 'Camp B', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO locations (id, campaign_id, name, created_at, updated_at) VALUES (10, 1, 'Home', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO locations (id, campaign_id, name, created_at, updated_at) VALUES (20, 2, 'Away', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO quests (id, campaign_id, title, created_at, updated_at) VALUES (11, 1, 'Local Quest', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO quests (id, campaign_id, title, created_at, updated_at) VALUES (21, 2, 'Foreign Quest', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO sessions (id, campaign_id, number, title, created_at, updated_at) VALUES (12, 1, 1, 'Local Session', ?, ?)").run(now, now);
      legacy.prepare("INSERT INTO sessions (id, campaign_id, number, title, created_at, updated_at) VALUES (22, 2, 1, 'Foreign Session', ?, ?)").run(now, now);
      // Valid same-campaign links — must survive the repair.
      legacy
        .prepare(
          "INSERT INTO encounters (id, campaign_id, name, location_id, quest_id, session_id, created_at, updated_at) VALUES (1, 1, 'Good', 10, 11, 12, ?, ?)",
        )
        .run(now, now);
      // Cross-campaign links — must be nullified.
      legacy
        .prepare(
          "INSERT INTO encounters (id, campaign_id, name, location_id, quest_id, session_id, created_at, updated_at) VALUES (2, 1, 'Bad', 20, 21, 22, ?, ?)",
        )
        .run(now, now);
      // Mixed: valid location, foreign quest — only the bad field clears.
      legacy
        .prepare(
          "INSERT INTO encounters (id, campaign_id, name, location_id, quest_id, session_id, created_at, updated_at) VALUES (3, 1, 'Mixed', 10, 21, 12, ?, ?)",
        )
        .run(now, now);
      legacy.prepare("DELETE FROM __migrations WHERE name = '0064_encounter_links_campaign_scope'").run();
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      const rows = upgraded.sqlite
        .prepare('SELECT id, location_id, quest_id, session_id FROM encounters ORDER BY id')
        .all() as Array<{ id: number; location_id: number | null; quest_id: number | null; session_id: number | null }>;
      expect(rows).toEqual([
        { id: 1, location_id: 10, quest_id: 11, session_id: 12 },
        { id: 2, location_id: null, quest_id: null, session_id: null },
        { id: 3, location_id: 10, quest_id: null, session_id: 12 },
      ]);
    } finally {
      upgraded.sqlite.close();
    }
  });

  // ── app-version compatibility guard (issue #726) ──────────────────────────
  //
  // The running binary's APP_VERSION is read from apps/server/package.json
  // (currently 0.14.1). These specs simulate the downgrade scenario — a DB last
  // migrated by a NEWER binary than the one now booting — by opening the file
  // once (which records the binary's own version), then hand-writing a HIGHER
  // version into __db_meta before a second openDatabase() call.

  /** The version openDatabase() will record / compare against (single-sourced from package.json). */
  const BINARY_VERSION = '0.14.1';

  it('compareAppVersions orders semver triples correctly', () => {
    expect(compareAppVersions('0.14.0', '0.14.1')).toBeLessThan(0);
    expect(compareAppVersions('0.14.1', '0.14.1')).toBe(0);
    expect(compareAppVersions('0.14.2', '0.14.1')).toBeGreaterThan(0);
    expect(compareAppVersions('0.15.0', '0.14.99')).toBeGreaterThan(0); // minor beats patch
    expect(compareAppVersions('1.0.0', '0.99.99')).toBeGreaterThan(0); // major beats minor
    // A pre-release suffix is treated as equal to its release (the project does
    // not gate on pre-release ordering; the safe direction for a downgrade guard).
    expect(compareAppVersions('0.14.1-rc.1', '0.14.1')).toBe(0);
    // Malformed stored values collapse to 0.0.0 — they can never read as "newer".
    expect(compareAppVersions('garbage', '0.14.1')).toBeLessThan(0);
  });

  it('records the running binary version in __db_meta after a successful boot', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    try {
      expect(getRecordedAppVersion(sqlite)).toBe(BINARY_VERSION);
      const row = sqlite
        .prepare("SELECT value, updated_at FROM __db_meta WHERE key = 'app_version'")
        .get() as { value: string; updated_at: string };
      expect(row.value).toBe(BINARY_VERSION);
      expect(typeof row.updated_at).toBe('string');
      expect(row.updated_at.length).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });

  it('refuses to boot when the DB was last migrated by a NEWER binary (downgrade)', () => {
    dataDir = makeTempDataDir();
    // First boot records the running binary's version and brings the schema up.
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    // Simulate the downgrade: a newer image previously migrated this DB, then an
    // older image was rolled out against it. We hand-stamp a higher recorded
    // version than THIS binary.
    const stamp = new Database(dbFilePath(dataDir));
    try {
      stamp
        .prepare(
          "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run('0.99.0', '2026-07-21T00:00:00.000Z');
    } finally {
      stamp.close();
    }

    // The older binary must refuse to boot — NOT silently run against the newer
    // schema. The error names the recorded + running versions and the two recourses.
    expect(() => openDatabase(dataDir)).toThrow(/NEWER than this running binary/);
    expect(() => openDatabase(dataDir)).toThrow(/v0\.99\.0/);
    expect(() => openDatabase(dataDir)).toThrow(new RegExp(BINARY_VERSION));
    expect(() => openDatabase(dataDir)).toThrow(/restore the pre-upgrade database snapshot/);
  });

  it('boots normally when the recorded version EQUALS the running binary (same/upgrade path)', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    sqlite.close();

    // Re-stamp the same version (simulating a re-deploy of the same image) — must boot.
    const stamp = new Database(dbFilePath(dataDir));
    try {
      stamp
        .prepare(
          "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(BINARY_VERSION, '2026-07-21T00:00:00.000Z');
    } finally {
      stamp.close();
    }

    expect(() => openDatabase(dataDir)).not.toThrow();
  });

  it('boots normally when the recorded version is OLDER than the running binary (upgrade)', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    sqlite.close();

    // An older image recorded a lower version; this newer binary upgrades it.
    const stamp = new Database(dbFilePath(dataDir));
    try {
      stamp
        .prepare(
          "INSERT INTO __db_meta (key, value, updated_at) VALUES ('app_version', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run('0.13.0', '2026-01-01T00:00:00.000Z');
    } finally {
      stamp.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      // A successful upgrade ADVANCES the recorded version to the running binary.
      expect(getRecordedAppVersion(upgraded.sqlite)).toBe(BINARY_VERSION);
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('boots a pre-issue-#726 DB (no __db_meta row) and records the version on first open', () => {
    dataDir = makeTempDataDir();
    // Hand-build a DB that has __migrations but predates the __db_meta table —
    // the real shape of every DB created before this change shipped.
    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec('CREATE TABLE __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      legacy.prepare("INSERT INTO __migrations (name, applied_at) VALUES ('0001_users_oidc', ?)").run('2024-01-01');
      expect(getRecordedAppVersion(legacy)).toBeNull();
    } finally {
      legacy.close();
    }

    // openDatabase treats a null recorded version as compatible (nothing to be
    // newer than) and records THIS binary's version on the successful boot.
    const opened = openDatabase(dataDir);
    try {
      expect(getRecordedAppVersion(opened.sqlite)).toBe(BINARY_VERSION);
    } finally {
      opened.sqlite.close();
    }
  });

  // ── public invites kill switch (#857) ───────────────────────────────────────

  it('0058 clears public_invites_enabled for paused campaigns when upgrading an old-shaped DB', () => {
    dataDir = makeTempDataDir();
    writeOldSchemaDb(dataDir);

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.prepare("UPDATE campaigns SET status = 'paused' WHERE id = 1").run();
    } finally {
      legacy.close();
    }

    const { sqlite } = openDatabase(dataDir);
    try {
      const row = sqlite.prepare('SELECT status, public_invites_enabled FROM campaigns WHERE id = 1').get() as {
        status: string;
        public_invites_enabled: number;
      };
      expect(row.status).toBe('paused');
      expect(row.public_invites_enabled).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('0059 clears public_invites_enabled left enabled on paused/completed/trashed campaigns', () => {
    dataDir = makeTempDataDir();
    const first = openDatabase(dataDir);
    const now = '2026-07-23T00:00:00.000Z';
    try {
      // Simulate a DB that applied the original 0058 (DEFAULT 1 for every row)
      // before the inactive-campaign clear landed.
      first.sqlite
        .prepare(
          `INSERT INTO campaigns (name, status, public_invites_enabled, deleted_at, created_at, updated_at)
           VALUES
             ('Active Live', 'active', 1, NULL, ?, ?),
             ('Paused Table', 'paused', 1, NULL, ?, ?),
             ('Completed Saga', 'completed', 1, NULL, ?, ?),
             ('Trashed Keep', 'active', 1, ?, ?, ?)`,
        )
        .run(now, now, now, now, now, now, now, now, now);
      first.sqlite.prepare("DELETE FROM __migrations WHERE name = '0059_public_invites_disabled_inactive'").run();
    } finally {
      first.sqlite.close();
    }

    const second = openDatabase(dataDir);
    try {
      const rows = second.sqlite
        .prepare(
          `SELECT name, status, public_invites_enabled, deleted_at IS NOT NULL AS trashed
           FROM campaigns
           WHERE name IN ('Active Live', 'Paused Table', 'Completed Saga', 'Trashed Keep')
           ORDER BY name`,
        )
        .all() as Array<{ name: string; status: string; public_invites_enabled: number; trashed: number }>;
      expect(rows).toEqual([
        { name: 'Active Live', status: 'active', public_invites_enabled: 1, trashed: 0 },
        { name: 'Completed Saga', status: 'completed', public_invites_enabled: 0, trashed: 0 },
        { name: 'Paused Table', status: 'paused', public_invites_enabled: 0, trashed: 0 },
        { name: 'Trashed Keep', status: 'active', public_invites_enabled: 0, trashed: 1 },
      ]);
      expect(MIGRATION_NAMES).toContain('0059_public_invites_disabled_inactive');
    } finally {
      second.sqlite.close();
    }
  });

  /**
   * Issue #559. `ai_driver_control_state` gained `announced_recovery` after the create-table
   * migration had already shipped under an earlier name and a column-less shape. Because
   * runMigrations skips any migration whose name is recorded in `__migrations`, a probe living
   * INSIDE the create-table migration would never run on the DBs that actually need it — the
   * column would stay missing, every drizzle read/write on the table would throw, and the
   * best-effort try/catch around persistence would swallow it, silently disabling restart-safety.
   * The backfill therefore has its own separate, never-before-recorded migration name, which this
   * exercises directly. Ordinals are deliberately not named here — this pair has been renumbered
   * several times as main moved, and a comment citing a name that no longer exists is exactly what
   * would mislead someone into reusing one.
   */
  it('backfills announced_recovery on a DB that recorded the CREATE before the column existed', () => {
    dataDir = makeTempDataDir();
    const first = openDatabase(dataDir);
    first.sqlite.close();

    // Rewind to the pre-column shape: drop the table, recreate it WITHOUT announced_recovery,
    // and leave the CREATE recorded while removing the backfill — exactly a DB from the build
    // that shipped the create-table migration before the column existed.
    const rewound = new Database(dbFilePath(dataDir));
    try {
      rewound.exec('DROP TABLE ai_driver_control_state');
      rewound.exec(`
        CREATE TABLE ai_driver_control_state (
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
          updated_at TEXT NOT NULL
        );
      `);
      rewound.prepare('DELETE FROM __migrations WHERE name = ?').run('0119_ai_driver_control_state_announced_recovery_559');
      expect(
        rewound.prepare('SELECT name FROM __migrations WHERE name = ?').get('0118_ai_driver_control_state_559'),
      ).toBeTruthy();
      expect(columnNames(rewound, 'ai_driver_control_state')).not.toContain('announced_recovery');
    } finally {
      rewound.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(MIGRATION_NAMES).toContain('0119_ai_driver_control_state_announced_recovery_559');
      expect(columnNames(upgraded.sqlite, 'ai_driver_control_state')).toContain('announced_recovery');
    } finally {
      upgraded.sqlite.close();
    }

    // And re-running on the already-backfilled file is a no-op, not a duplicate-column error.
    const again = openDatabase(dataDir);
    try {
      expect(columnNames(again.sqlite, 'ai_driver_control_state')).toContain('announced_recovery');
    } finally {
      again.sqlite.close();
    }
  });
  /**
   * Issue #597 — the migration posture, asserted rather than described.
   *
   * The tightening's DEFAULT is read-only (interactive_guest 0), but applying that
   * unmodified to an existing install would silently gag viewers who have been posting
   * at live tables. 0127 therefore grandfathers, and grandfathers NARROWLY: only viewer
   * seats that have already authored OUTBOUND content in that same campaign, only once,
   * and with an audit row per seat so a DM can see and reverse it.
   */
  it('0127 adds the viewer capability and grandfathers only viewers who had already posted (#597)', () => {
    dataDir = makeTempDataDir();
    const first = openDatabase(dataDir);
    first.sqlite.close();

    // Rewind to the pre-#597 shape: campaign_members without interactive_guest,
    // notifications without actor_user_id, and the migration un-recorded.
    const rewound = new Database(dbFilePath(dataDir));
    try {
      rewound.pragma('foreign_keys = OFF');
      rewound.exec('DROP TABLE campaign_members');
      rewound.exec(`
        CREATE TABLE campaign_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          character_id INTEGER,
          ai_external_use_consent INTEGER NOT NULL DEFAULT 0,
          is_primary_owner INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const ts = '2026-01-01T00:00:00.000Z';
      const seat = rewound.prepare(
        'INSERT INTO campaign_members (campaign_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      seat.run(1, 101, 'viewer', ts, ts); // has commented -> grandfathered
      seat.run(1, 102, 'viewer', ts, ts); // only a PRIVATE note -> stays read-only
      seat.run(1, 103, 'viewer', ts, ts); // silent -> stays read-only
      seat.run(1, 104, 'player', ts, ts); // role is already interactive; flag irrelevant

      rewound
        .prepare(
          `INSERT INTO comments (campaign_id, entity_type, entity_id, author_user_id, author_name, body, created_at, updated_at)
           VALUES (1, 'session', 1, '101', 'Chatty Viewer', 'I have been talking here for months', ?, ?)`,
        )
        .run(ts, ts);
      rewound
        .prepare(
          `INSERT INTO notes (campaign_id, author_user_id, author_name, kind, visibility, body, resolved, resolved_note, created_at, updated_at)
           VALUES (1, '102', 'Quiet Viewer', 'note', 'private', 'just for me', 0, '', ?, ?)`,
        )
        .run(ts, ts);

      rewound.prepare('DELETE FROM __migrations WHERE name = ?').run('0127_safety_controls_597');
      expect(columnNames(rewound, 'campaign_members')).not.toContain('interactive_guest');
    } finally {
      rewound.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(MIGRATION_NAMES).toContain('0127_safety_controls_597');
      expect(columnNames(upgraded.sqlite, 'campaign_members')).toContain('interactive_guest');
      expect(columnNames(upgraded.sqlite, 'notifications')).toContain('actor_user_id');
      expect(columnNames(upgraded.sqlite, 'notification_digest_queue')).toContain('actor_user_id');

      const flagOf = (userId: number) =>
        (
          upgraded.sqlite
            .prepare('SELECT interactive_guest AS f FROM campaign_members WHERE user_id = ?')
            .get(userId) as { f: number }
        ).f;
      expect(flagOf(101)).toBe(1); // had commented -> keeps taking part
      expect(flagOf(102)).toBe(0); // private notes only -> never needed the capability
      expect(flagOf(103)).toBe(0); // silent viewer -> read-only, as documented
      expect(flagOf(104)).toBe(0); // player: interactive by role, flag stays off

      // Every grandfathered seat leaves a trail the DM can find and reverse.
      const audited = upgraded.sqlite
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'member.interactive_guest.grandfathered'")
        .get() as { c: number };
      expect(audited.c).toBe(1);
    } finally {
      upgraded.sqlite.close();
    }

    // Re-running must not re-grandfather a seat a DM has since revoked, and must not
    // duplicate the audit row. This is why the migration name is never renamed.
    const revoked = new Database(dbFilePath(dataDir));
    try {
      revoked.prepare('UPDATE campaign_members SET interactive_guest = 0 WHERE user_id = 101').run();
    } finally {
      revoked.close();
    }
    const again = openDatabase(dataDir);
    try {
      const flag = (
        again.sqlite.prepare('SELECT interactive_guest AS f FROM campaign_members WHERE user_id = ?').get(101) as {
          f: number;
        }
      ).f;
      expect(flag).toBe(0);
      const audited = again.sqlite
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'member.interactive_guest.grandfathered'")
        .get() as { c: number };
      expect(audited.c).toBe(1);
    } finally {
      again.sqlite.close();
    }
  });

  it('0132 adds characters.condition_instances and leaves bare legacy strings readable (#1047)', () => {
    dataDir = makeTempDataDir();
    const first = openDatabase(dataDir);
    first.sqlite.close();

    // Rewind to the pre-#1047 shape: characters WITHOUT condition_instances, holding the
    // bare strings every existing install has, and the migration un-recorded.
    const rewound = new Database(dbFilePath(dataDir));
    const ts = '2026-01-01T00:00:00.000Z';
    try {
      rewound.pragma('foreign_keys = OFF');
      rewound.exec('ALTER TABLE characters DROP COLUMN condition_instances');
      rewound
        .prepare(
          `INSERT INTO characters (id, campaign_id, name, hp_current, hp_max, conditions, status, created_at, updated_at)
           VALUES (901, 1, 'Legacy PC', 10, 10, ?, 'active', ?, ?)`,
        )
        .run(JSON.stringify(['poisoned', 'exhaustion']), ts, ts);
      rewound.prepare('DELETE FROM __migrations WHERE name = ?').run('0132_character_condition_instances_1047');
      expect(columnNames(rewound, 'characters')).not.toContain('condition_instances');
    } finally {
      rewound.close();
    }

    const again = openDatabase(dataDir);
    try {
      expect(columnNames(again.sqlite, 'characters')).toContain('condition_instances');

      // Deliberately NOT backfilled — the reader derives instances from the legacy names,
      // so a rewrite of every character row on upgrade would be redundant data to keep in
      // step forever. The legacy column must be untouched.
      const row = again.sqlite
        .prepare('SELECT conditions, condition_instances FROM characters WHERE id = 901')
        .get() as { conditions: string; condition_instances: string | null };
      expect(row.condition_instances).toBeNull();
      expect(JSON.parse(row.conditions)).toEqual(['poisoned', 'exhaustion']);
    } finally {
      again.sqlite.close();
    }
  });

  it('reconciles every pending-resolution column and invalidates legacy rows when earlier 0145 is recorded (#1451)', () => {
    expect(MIGRATION_NAMES).toContain('0145_action_pending_resolutions_1451');
    expect(MIGRATION_NAMES).toContain('0145_action_pending_fingerprint_1451');
    expect(MIGRATION_NAMES.indexOf('0145_action_pending_fingerprint_1451')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('0145_action_pending_resolutions_1451'),
    );

    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    // Reproduce the earliest 0145 table: the original migration is recorded, but none of the
    // later confirmation/index/fingerprint columns exist and an unresolved legacy row remains.
    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN action_fingerprint');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN action_index');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN awaiting_confirmation');
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0145_action_pending_fingerprint_1451');
      legacy
        .prepare(
          `INSERT INTO action_pending_resolutions
            (id, encounter_id, campaign_id, actor_combatant_id, action_name, resolution_json, created_at)
           VALUES ('legacy-pending-row', 1, 1, 1, 'Greatsword', '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      expect(columnNames(legacy, 'action_pending_resolutions')).not.toEqual(
        expect.arrayContaining(['awaiting_confirmation', 'action_index', 'action_fingerprint']),
      );
      expect(
        (legacy.prepare('SELECT name FROM __migrations WHERE name = ?').get('0145_action_pending_resolutions_1451') as { name?: string })
          ?.name,
      ).toBe('0145_action_pending_resolutions_1451');
      expect(
        legacy.prepare('SELECT name FROM __migrations WHERE name = ?').get('0145_action_pending_fingerprint_1451'),
      ).toBeUndefined();
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'action_pending_resolutions')).toEqual(
        expect.arrayContaining(['awaiting_confirmation', 'action_index', 'action_fingerprint']),
      );
      expect(
        upgraded.sqlite.prepare("SELECT id FROM action_pending_resolutions WHERE id = 'legacy-pending-row'").get(),
      ).toBeUndefined();
      expect(
        (upgraded.sqlite.prepare('SELECT name FROM __migrations WHERE name = ?').get('0145_action_pending_fingerprint_1451') as { name?: string })
          ?.name,
      ).toBe('0145_action_pending_fingerprint_1451');
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('reconciles the intermediate awaiting-confirmation 0145 shape (#1451)', () => {
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    // A later reviewed head had awaiting_confirmation but not the selected-action index or
    // fingerprint. The tail migration must preserve that shape's compatibility too.
    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN action_fingerprint');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN action_index');
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0145_action_pending_fingerprint_1451');
      legacy
        .prepare(
          `INSERT INTO action_pending_resolutions
            (id, encounter_id, campaign_id, actor_combatant_id, action_name, awaiting_confirmation, resolution_json, created_at)
           VALUES ('legacy-awaiting-row', 1, 1, 1, 'Greatsword', 1, '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      expect(columnNames(legacy, 'action_pending_resolutions')).toContain('awaiting_confirmation');
      expect(columnNames(legacy, 'action_pending_resolutions')).not.toEqual(
        expect.arrayContaining(['action_index', 'action_fingerprint']),
      );
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'action_pending_resolutions')).toEqual(
        expect.arrayContaining(['awaiting_confirmation', 'action_index', 'action_fingerprint']),
      );
      expect(
        upgraded.sqlite.prepare("SELECT id FROM action_pending_resolutions WHERE id = 'legacy-awaiting-row'").get(),
      ).toBeUndefined();
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('adds server-owned turn versions after 0145 is already recorded (#1316)', () => {
    expect(MIGRATION_NAMES).toContain('0146_action_pending_turn_version_1316');

    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN turn_round');
      legacy.exec('ALTER TABLE action_pending_resolutions DROP COLUMN turn_version');
      legacy.exec('ALTER TABLE encounters DROP COLUMN turn_version');
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0146_action_pending_turn_version_1316');
      legacy
        .prepare(
          `INSERT INTO action_pending_resolutions
            (id, encounter_id, campaign_id, actor_combatant_id, action_name, action_index, action_fingerprint, awaiting_confirmation, resolution_json, created_at)
           VALUES ('legacy-pending-round', 1, 1, 1, 'Greatsword', 0, 'fingerprint', 0, '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      expect(columnNames(legacy, 'action_pending_resolutions')).not.toContain('turn_round');
      expect(columnNames(legacy, 'action_pending_resolutions')).not.toContain('turn_version');
      expect(columnNames(legacy, 'encounters')).not.toContain('turn_version');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'action_pending_resolutions')).toEqual(expect.arrayContaining(['turn_round', 'turn_version']));
      expect(columnNames(upgraded.sqlite, 'encounters')).toContain('turn_version');
      expect(
        upgraded.sqlite.prepare("SELECT turn_round, turn_version FROM action_pending_resolutions WHERE id = 'legacy-pending-round'").get(),
      ).toEqual({ turn_round: 0, turn_version: -1 });
      expect(
        (upgraded.sqlite.prepare('SELECT name FROM __migrations WHERE name = ?').get('0146_action_pending_turn_version_1316') as { name?: string })
          ?.name,
      ).toBe('0146_action_pending_turn_version_1316');
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('adds NPC disposition snapshots after the #1316 0146 upgrade (#1454)', () => {
    expect(MIGRATION_NAMES).toContain('0147_combatants_npc_disposition_snapshot_1454');
    expect(MIGRATION_NAMES.indexOf('0147_combatants_npc_disposition_snapshot_1454')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('0146_action_pending_turn_version_1316'),
    );

    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.exec('ALTER TABLE combatants DROP COLUMN npc_disposition_snapshot');
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0147_combatants_npc_disposition_snapshot_1454');
      expect(columnNames(legacy, 'combatants')).not.toContain('npc_disposition_snapshot');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'combatants')).toContain('npc_disposition_snapshot');
      expect(
        (upgraded.sqlite.prepare('SELECT name FROM __migrations WHERE name = ?').get('0147_combatants_npc_disposition_snapshot_1454') as { name?: string })
          ?.name,
      ).toBe('0147_combatants_npc_disposition_snapshot_1454');
    } finally {
      upgraded.sqlite.close();
    }
  });
  it('adds the rule_packs manifest_hash column when upgrading a pre-#1518 DB (#1518)', () => {
    expect(MIGRATION_NAMES).toContain('0148_rule_packs_manifest_hash_1518');

    // Start from a fully-migrated DB, then rewind rule_packs to its pre-#1518 shape (no
    // manifest_hash column, the migration un-recorded) and seed a pack — the same shape a DB
    // last booted before #1518 would present on upgrade.
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      legacy.exec('ALTER TABLE rule_packs DROP COLUMN manifest_hash');
      legacy
        .prepare('DELETE FROM __migrations WHERE name = ?')
        .run('0148_rule_packs_manifest_hash_1518');
      legacy
        .prepare(
          `INSERT INTO rule_packs
            (slug, name, version, license, source_url, installed_at, entry_count)
           VALUES ('legacy-srd', 'Legacy SRD', 'v1', 'CC-BY-4.0', 'https://example.invalid', '2026-01-01T00:00:00.000Z', 3)`,
        )
        .run();
      expect(columnNames(legacy, 'rule_packs')).not.toContain('manifest_hash');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      // The migration re-runs and adds the column.
      expect(columnNames(upgraded.sqlite, 'rule_packs')).toContain('manifest_hash');
      expect(
        (upgraded.sqlite
          .prepare('SELECT name FROM __migrations WHERE name = ?')
          .get('0148_rule_packs_manifest_hash_1518') as { name?: string })?.name,
      ).toBe('0148_rule_packs_manifest_hash_1518');
      // The seeded pack gets the '' default: no tracked manifest, so the re-import short-circuit
      // treats it as a miss and runs the full transactional classification (re-stamping the hash
      // on the next install/sync) — behaviour unchanged from before the column existed.
      const row = upgraded.sqlite
        .prepare("SELECT manifest_hash FROM rule_packs WHERE slug = 'legacy-srd'")
        .get() as { manifest_hash: string };
      expect(row.manifest_hash).toBe('');
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('adds inventory_items equip/unequip columns when upgrading a pre-#1326 DB', () => {
    expect(MIGRATION_NAMES).toContain('0152_inventory_items_equip_1326');

    // Start from a fully-migrated DB, seed a live item, then rewind inventory_items to its
    // pre-#1326 shape (no equipped/equip_slot/equipped_action columns, migration un-recorded)
    // — the same shape a DB last booted before #1326 would present on upgrade.
    dataDir = makeTempDataDir();
    const seeded = openDatabase(dataDir);
    const ts = new Date().toISOString();
    seeded.sqlite.prepare(`INSERT INTO campaigns (name, created_at, updated_at) VALUES ('Upgrade Campaign', ?, ?)`).run(ts, ts);
    const campaignId = (seeded.sqlite.prepare("SELECT id FROM campaigns WHERE name = 'Upgrade Campaign'").get() as { id: number }).id;
    seeded.sqlite
      .prepare(
        `INSERT INTO inventory_items (campaign_id, owner_type, name, qty, notes, icon_slug, created_at, updated_at)
         VALUES (?, 'party', 'Legacy Rope', 1, '', '', ?, ?)`,
      )
      .run(campaignId, ts, ts);
    seeded.sqlite.close();

    const legacy = new Database(dbFilePath(dataDir));
    try {
      legacy.pragma('foreign_keys = OFF');
      legacy.exec('DROP INDEX IF EXISTS idx_inventory_items_character_equipped');
      legacy.exec('ALTER TABLE inventory_items DROP COLUMN equipped');
      legacy.exec('ALTER TABLE inventory_items DROP COLUMN equip_slot');
      legacy.exec('ALTER TABLE inventory_items DROP COLUMN equipped_action');
      legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0152_inventory_items_equip_1326');
      expect(columnNames(legacy, 'inventory_items')).not.toContain('equipped');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'inventory_items')).toEqual(
        expect.arrayContaining(['equipped', 'equip_slot', 'equipped_action']),
      );
      expect(
        (upgraded.sqlite
          .prepare('SELECT name FROM __migrations WHERE name = ?')
          .get('0152_inventory_items_equip_1326') as { name?: string })?.name,
      ).toBe('0152_inventory_items_equip_1326');
      expect(
        (upgraded.sqlite.pragma('index_list(inventory_items)') as Array<{ name: string }>).map((i) => i.name),
      ).toContain('idx_inventory_items_character_equipped');
      // The pre-existing row upgrades as unequipped, never silently promoted.
      const row = upgraded.sqlite.prepare("SELECT equipped, equip_slot FROM inventory_items WHERE name = 'Legacy Rope'").get() as {
        equipped: number;
        equip_slot: string | null;
      };
      expect(row.equipped).toBe(0);
      expect(row.equip_slot).toBeNull();
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('0153 adds the aftermath_grant_window column to ai_driver_control_state when upgrading (#1781)', () => {
    expect(MIGRATION_NAMES).toContain('0153_ai_driver_aftermath_grant_window_1781');

    dataDir = makeTempDataDir();
    const legacy = new Database(dbFilePath(dataDir));
    try {
      // Simulate legacy ai_driver_control_state schema prior to 0153
      legacy.exec(`
        CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL);
        CREATE TABLE ai_driver_control_state (
          campaign_id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          state TEXT NOT NULL,
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
          secret_read_approvals TEXT,
          pending_tool_confirmations TEXT,
          phase TEXT NOT NULL DEFAULT 'active',
          collaborative INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
      expect(columnNames(legacy, 'ai_driver_control_state')).not.toContain('aftermath_grant_window');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'ai_driver_control_state')).toContain('aftermath_grant_window');
      expect(
        (
          upgraded.sqlite
            .prepare('SELECT name FROM __migrations WHERE name = ?')
            .get('0153_ai_driver_aftermath_grant_window_1781') as { name?: string }
        )?.name,
      ).toBe('0153_ai_driver_aftermath_grant_window_1781');
    } finally {
      upgraded.sqlite.close();
    }
  });

  it('ensureSoftDeleteColumns backfills missing deleted_at columns on boot even if __migrations recorded all migrations', () => {
    dataDir = makeTempDataDir();
    const { sqlite } = openDatabase(dataDir);
    sqlite.close();

    // Simulate an existing database where all migrations are recorded, but a table is missing deleted_at
    const manual = new Database(dbFilePath(dataDir));
    try {
      manual.exec('ALTER TABLE encounters DROP COLUMN deleted_at');
      expect(columnNames(manual, 'encounters')).not.toContain('deleted_at');
    } finally {
      manual.close();
    }

    // openDatabase must run ensureSoftDeleteColumns and add back deleted_at
    const booted = openDatabase(dataDir);
    try {
      expect(columnNames(booted.sqlite, 'encounters')).toContain('deleted_at');
    } finally {
      booted.sqlite.close();
    }
  });

  it('upgrades removal receipt retries to actor-scoped keys without losing prior receipts (#1469)', () => {
     expect(MIGRATION_NAMES).toContain('0150_combatant_remove_undo_1469');
     expect(MIGRATION_NAMES).toContain('0151_combatant_remove_revision_1469');

    dataDir = makeTempDataDir();
    const fresh = openDatabase(dataDir);
    try {
      expect(columnNames(fresh.sqlite, 'combatant_removal_undos')).toEqual(expect.arrayContaining(['actor_id', 'request_key']));
      const freshIndex = fresh.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_combatant_removal_undos_request'")
        .get() as { sql: string };
      expect(freshIndex.sql).toContain('encounter_id, actor_id, request_key');
    } finally {
      fresh.sqlite.close();
    }

    // Rewind just the final revision to the shape shipped by the first #1469
    // migration. Existing receipts must remain readable, while fresh receipts
    // receive the actor-scoped key index.
    const legacy = new Database(dbFilePath(dataDir));
    try {
      // The fixture only needs a historical receipt row; it intentionally does
      // not seed the surrounding encounter tables.
      legacy.pragma('foreign_keys = OFF');
      legacy.exec('DROP INDEX IF EXISTS idx_combatant_removal_undos_request');
      legacy.exec('ALTER TABLE combatant_removal_undos DROP COLUMN actor_id');
      legacy.exec('CREATE UNIQUE INDEX idx_combatant_removal_undos_request ON combatant_removal_undos(encounter_id, request_key) WHERE request_key IS NOT NULL');
      legacy
        .prepare(`INSERT INTO combatant_removal_undos
          (token, encounter_id, combatant_id, request_key, snapshot_json, before_encounter_json, after_encounter_json, expires_at, created_at)
          VALUES (?, 1, 1, 'legacy-key', '{}', '{}', '{}', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
        .run('legacy-removal-receipt');
       legacy.prepare('DELETE FROM __migrations WHERE name = ?').run('0151_combatant_remove_revision_1469');
      legacy.pragma('foreign_keys = ON');
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(dataDir);
    try {
      expect(columnNames(upgraded.sqlite, 'combatant_removal_undos')).toContain('actor_id');
      expect(
        upgraded.sqlite.prepare('SELECT actor_id FROM combatant_removal_undos WHERE token = ?').get('legacy-removal-receipt'),
      ).toEqual({ actor_id: '' });
      const indexColumns = upgraded.sqlite
        .prepare("SELECT name FROM pragma_index_info('idx_combatant_removal_undos_request') ORDER BY seqno")
        .all() as Array<{ name: string }>;
      expect(indexColumns.map((column) => column.name)).toEqual(['encounter_id', 'actor_id', 'request_key']);
     } finally {
       upgraded.sqlite.close();
     }
   });
});
