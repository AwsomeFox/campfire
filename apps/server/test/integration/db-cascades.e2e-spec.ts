import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from '../test-app';
import { dm, openRawDb, countRows, seedFullCampaign } from './fixtures';

/**
 * Integration coverage for the hand-rolled campaign-delete cascade (issue #96,
 * per issue #80). CampaignsService.remove deletes ~13 child tables by hand inside
 * one transaction — exactly the kind of list that silently rots when a new child
 * table is added and forgotten. Rather than trust the HTTP 204, we open the real
 * SQLite file afterwards and assert there are literally zero rows left referencing
 * the deleted campaign, in every table — including the two-hop children
 * (quest_objectives off quests, combatants off encounters) that don't carry a
 * campaign_id of their own.
 */
describe('campaign delete cascade (real SQLite, no orphan rows)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('leaves no orphan rows in any child table after deleting a campaign', async () => {
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

    const del = await request(server).delete(`/api/v1/campaigns/${campaignId}`).set(dm);
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

  it('deletes only the target campaign — a sibling campaign is untouched', async () => {
    const server = ctx.app.getHttpServer();
    const doomed = await seedFullCampaign(server, 'Sacrificial Campaign');
    const keeper = await seedFullCampaign(server, 'Surviving Campaign');

    const del = await request(server).delete(`/api/v1/campaigns/${doomed.campaignId}`).set(dm);
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
