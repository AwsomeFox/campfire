import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from '../test-app';
import { dm, openRawDb, countRows, seedFullCampaign } from './fixtures';
import { DB_HOLDER, type DbHolder } from '../../src/db/db.module';

/**
 * Integration coverage for the hand-rolled campaign PURGE cascade (issue #96, per
 * issue #80; now the deliberate 2nd step under issue #116). CampaignsService.purge
 * deletes ~13 child tables by hand inside one transaction — exactly the kind of list
 * that silently rots when a new child table is added and forgotten. Rather than trust
 * the HTTP 200, we open the real SQLite file afterwards and assert there are literally
 * zero rows left referencing the purged campaign, in every table — including the
 * two-hop children (quest_objectives off quests, combatants off encounters) that don't
 * carry a campaign_id of their own. The default DELETE is now a soft-delete; only PURGE
 * runs this cascade.
 */
describe('campaign purge cascade (real SQLite, no orphan rows)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('leaves no orphan rows in any child table after purging a campaign', async () => {
    const server = ctx.app.getHttpServer();
    const { campaignId, questId, encounterId } = await seedFullCampaign(server, 'Doomed Campaign');

    // Sanity: the children really exist on disk before the delete.
    const before = openRawDb(ctx.dataDir);
    try {
      expect(countRows(before, 'characters', `campaign_id = ${campaignId}`)).toBe(1);
      expect(countRows(before, 'quest_objectives', `quest_id = ${questId}`)).toBe(1);
      expect(countRows(before, 'combatants', `encounter_id = ${encounterId}`)).toBe(1);
      expect(countRows(before, 'proposals', `campaign_id = ${campaignId}`)).toBe(1);
    } finally {
      before.close();
    }

    // Soft-delete first (the default DELETE, issue #116) — rows must all still be present.
    const soft = await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm);
    expect(soft.status).toBe(200);
    const midway = openRawDb(ctx.dataDir);
    try {
      expect(countRows(midway, 'characters', `campaign_id = ${campaignId}`)).toBe(1);
      expect(countRows(midway, 'campaigns', `id = ${campaignId} AND deleted_at IS NOT NULL`)).toBe(1);
    } finally {
      midway.close();
    }

    // Now the deliberate purge runs the real hard cascade.
    const del = await request(server).delete(`/api/v1/campaigns/${campaignId}/purge`).set(dm);
    expect(del.status).toBe(200);

    // The DB is the source of truth — inspect it directly for orphans.
    const after = openRawDb(ctx.dataDir);
    try {
      const campaignScoped = [
        'characters',
        'quests',
        'npcs',
        'locations',
        'notes',
        'sessions',
        'proposals',
        'encounters',
        'attachments',
        'campaign_members',
        'api_tokens',
      ];
      for (const table of campaignScoped) {
        expect({ table, rows: countRows(after, table, `campaign_id = ${campaignId}`) }).toEqual({ table, rows: 0 });
      }
      // Two-hop children keyed off the parent's id, not campaign_id.
      expect(countRows(after, 'quest_objectives', `quest_id = ${questId}`)).toBe(0);
      expect(countRows(after, 'combatants', `encounter_id = ${encounterId}`)).toBe(0);
      // The campaign row itself is gone.
      expect(countRows(after, 'campaigns', `id = ${campaignId}`)).toBe(0);
    } finally {
      after.close();
    }
  });

  it('soft-deletes a character (issue #116) — the row survives (deleted_at set) and its refs are preserved', async () => {
    const server = ctx.app.getHttpServer();
    const { encounterId, characterId } = await seedFullCampaign(server, 'Character Delete Campaign');

    // Link the character into the fight (a combatant) so an inbound soft ref exists.
    await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'pc', name: 'Cascade Hero', characterId, hpMax: 20, hpCurrent: 20 });

    const before = openRawDb(ctx.dataDir);
    try {
      expect(countRows(before, 'combatants', `character_id = ${characterId}`)).toBe(1);
    } finally {
      before.close();
    }

    const del = await request(server).delete(`/api/v1/characters/${characterId}`).set(dm);
    expect(del.status).toBe(200);

    const after = openRawDb(ctx.dataDir);
    try {
      // The character row SURVIVES — it's trashed (deleted_at set), not destroyed, so it
      // stays fully restorable and no inbound FK ever dangles (the ref points at a real,
      // if hidden, row). This is the reversible replacement for the old hard delete.
      expect(countRows(after, 'characters', `id = ${characterId} AND deleted_at IS NOT NULL`)).toBe(1);
      expect(countRows(after, 'combatants', `character_id = ${characterId}`)).toBe(1);
    } finally {
      after.close();
    }

    // And the GET/list reads hide it while it's trashed; restore brings it straight back.
    const gone = await request(server).get(`/api/v1/characters/${characterId}`).set(dm);
    expect(gone.status).toBe(404);
    const restored = await request(server).post(`/api/v1/characters/${characterId}/restore`).set(dm);
    expect(restored.status).toBe(201);
  });

  /**
   * Issue #235: the regression guard for the ~16 newer child tables the old cascade
   * forgot. Fresh test DBs enforce FKs, so a bare `DELETE FROM campaigns` would clean
   * everything via ON DELETE CASCADE and HIDE an incomplete manual cascade. Legacy
   * (pre-#69) DBs carry NO constraints and rely SOLELY on the hand cascade in purge().
   * To exercise exactly that path, we turn `foreign_keys` OFF on the app's own
   * connection before purging, so ONLY the manual deletes run — then assert literally
   * zero rows survive in EVERY campaign-scoped table, including the ones (story_*,
   * timeline_*, session_zero, factions, session_shares/attendees, scheduled_sessions/
   * rsvps, comments, entity_revisions, campaign_invites, dice_rolls, notifications,
   * inventory_items, party_treasury, ai_dm_seats, encounter_events) that no endpoint
   * conveniently seeds. We insert those directly on the same connection so the row set
   * is exhaustive regardless of which modules have HTTP create routes.
   */
  it('manual cascade (FK off, legacy path) leaves zero orphans in EVERY campaign-scoped table', async () => {
    const server = ctx.app.getHttpServer();
    const holder = ctx.app.get<DbHolder>(DB_HOLDER);
    const raw = holder.raw;

    const { campaignId, questId, encounterId, characterId } = await seedFullCampaign(server, 'Total Orphan Sweep');
    const sessionId = (raw.prepare('SELECT id FROM sessions WHERE campaign_id = ?').get(campaignId) as { id: number }).id;

    const now = '2026-01-01T00:00:00.000Z';
    const run = (sql: string, ...params: unknown[]): number =>
      Number(raw.prepare(sql).run(...params).lastInsertRowid);

    // Directly seed one row into every child table the HTTP seed doesn't reach, plus the
    // two-hop parents (arc→beat→branch, scheduled_session→rsvp) so their children exist.
    const arcId = run('INSERT INTO story_arcs (campaign_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', campaignId, 'Arc', now, now);
    const beatId = run('INSERT INTO story_beats (campaign_id, arc_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', campaignId, arcId, 'Beat', now, now);
    run('INSERT INTO story_branches (beat_id, label) VALUES (?, ?)', beatId, 'Branch');
    run('INSERT INTO timeline_events (campaign_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', campaignId, 'Event', now, now);
    run('INSERT INTO timeline_calendars (campaign_id, created_at, updated_at) VALUES (?, ?, ?)', campaignId, now, now);
    run('INSERT INTO session_zero (campaign_id, created_at, updated_at) VALUES (?, ?, ?)', campaignId, now, now);
    run('INSERT INTO factions (campaign_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', campaignId, 'Faction', now, now);
    run('INSERT INTO session_shares (session_id, campaign_id, token_hash, token_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', sessionId, campaignId, 'hash-235', 'pfx', now, now);
    run('INSERT INTO session_attendees (session_id, character_id, created_at) VALUES (?, ?, ?)', sessionId, characterId, now);
    const scheduledId = run('INSERT INTO scheduled_sessions (campaign_id, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?)', campaignId, now, now, now);
    run('INSERT INTO session_rsvps (scheduled_session_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', scheduledId, 'u1', 'yes', now, now);
    run('INSERT INTO comments (campaign_id, entity_type, entity_id, author_user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', campaignId, 'quest', questId, 'u1', 'hi', now, now);
    run('INSERT INTO entity_revisions (campaign_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?)', campaignId, 'quest', questId, now);
    run('INSERT INTO campaign_invites (campaign_id, code, role, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', campaignId, 'code-235', 'player', now, now, now);
    run('INSERT INTO dice_rolls (campaign_id, roller_user_id, expr, total, created_at) VALUES (?, ?, ?, ?, ?)', campaignId, 'u1', '1d20', 12, now);
    run('INSERT INTO notifications (user_id, campaign_id, type, title, created_at) VALUES (?, ?, ?, ?, ?)', 1, campaignId, 'mention', 'Hi', now);
    run('INSERT INTO inventory_items (campaign_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', campaignId, 'Rope', now, now);
    run('INSERT INTO party_treasury (campaign_id, updated_at) VALUES (?, ?)', campaignId, now);
    run('INSERT INTO ai_dm_seats (campaign_id, created_at, updated_at) VALUES (?, ?, ?)', campaignId, now, now);
    run('INSERT INTO encounter_events (encounter_id, type, created_at) VALUES (?, ?, ?)', encounterId, 'damage', now);
    run('INSERT INTO api_tokens (user_id, name, scope, campaign_id, token_hash, token_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 1, 'tok', 'dm', campaignId, 'tok-hash-235', 'tokpfx', now, now);

    // Force the legacy (no-FK) teardown: only the hand cascade in purge() runs now, so an
    // incomplete list would leave real orphans instead of being masked by ON DELETE CASCADE.
    raw.pragma('foreign_keys = OFF');
    try {
      const del = await request(server).delete(`/api/v1/campaigns/${campaignId}/purge`).set(dm);
      expect(del.status).toBe(200);
    } finally {
      raw.pragma('foreign_keys = ON');
    }

    const after = openRawDb(ctx.dataDir);
    try {
      // Every table keyed directly off campaign_id must be empty for this campaign.
      const campaignScoped = [
        'characters', 'quests', 'story_arcs', 'story_beats', 'timeline_events', 'timeline_calendars',
        'session_zero', 'npcs', 'factions', 'locations', 'sessions', 'session_shares', 'scheduled_sessions',
        'notes', 'comments', 'entity_revisions', 'campaign_members', 'campaign_invites', 'api_tokens',
        'proposals', 'attachments', 'encounters', 'dice_rolls', 'notifications', 'inventory_items',
        'party_treasury', 'ai_dm_seats',
      ];
      for (const table of campaignScoped) {
        expect({ table, rows: countRows(after, table, `campaign_id = ${campaignId}`) }).toEqual({ table, rows: 0 });
      }
      // Two-hop children keyed off a parent id, not campaign_id.
      expect({ t: 'quest_objectives', rows: countRows(after, 'quest_objectives', `quest_id = ${questId}`) }).toEqual({ t: 'quest_objectives', rows: 0 });
      expect({ t: 'combatants', rows: countRows(after, 'combatants', `encounter_id = ${encounterId}`) }).toEqual({ t: 'combatants', rows: 0 });
      expect({ t: 'encounter_events', rows: countRows(after, 'encounter_events', `encounter_id = ${encounterId}`) }).toEqual({ t: 'encounter_events', rows: 0 });
      expect({ t: 'session_attendees', rows: countRows(after, 'session_attendees', `session_id = ${sessionId}`) }).toEqual({ t: 'session_attendees', rows: 0 });
      expect({ t: 'session_rsvps', rows: countRows(after, 'session_rsvps', `scheduled_session_id = ${scheduledId}`) }).toEqual({ t: 'session_rsvps', rows: 0 });
      expect({ t: 'story_branches', rows: countRows(after, 'story_branches', `beat_id = ${beatId}`) }).toEqual({ t: 'story_branches', rows: 0 });
      // The campaign row itself is gone.
      expect(countRows(after, 'campaigns', `id = ${campaignId}`)).toBe(0);
    } finally {
      after.close();
    }
  });

  it('purges only the target campaign — a sibling campaign is untouched', async () => {
    const server = ctx.app.getHttpServer();
    const doomed = await seedFullCampaign(server, 'Sacrificial Campaign');
    const keeper = await seedFullCampaign(server, 'Surviving Campaign');

    const del = await request(server).delete(`/api/v1/campaigns/${doomed.campaignId}/purge`).set(dm);
    expect(del.status).toBe(200);

    const after = openRawDb(ctx.dataDir);
    try {
      // Doomed campaign fully gone...
      expect(countRows(after, 'characters', `campaign_id = ${doomed.campaignId}`)).toBe(0);
      expect(countRows(after, 'quest_objectives', `quest_id = ${doomed.questId}`)).toBe(0);
      // ...while the sibling's rows all survive, including its two-hop children.
      expect(countRows(after, 'campaigns', `id = ${keeper.campaignId}`)).toBe(1);
      expect(countRows(after, 'characters', `campaign_id = ${keeper.campaignId}`)).toBe(1);
      expect(countRows(after, 'quests', `campaign_id = ${keeper.campaignId}`)).toBe(1);
      expect(countRows(after, 'quest_objectives', `quest_id = ${keeper.questId}`)).toBe(1);
      expect(countRows(after, 'combatants', `encounter_id = ${keeper.encounterId}`)).toBe(1);
      expect(countRows(after, 'proposals', `campaign_id = ${keeper.campaignId}`)).toBe(1);
    } finally {
      after.close();
    }
  });
});
