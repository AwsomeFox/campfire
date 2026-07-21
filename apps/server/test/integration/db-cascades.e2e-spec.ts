import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from '../test-app';
import { dm, openRawDb, countRows, seedFullCampaign } from './fixtures';

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
