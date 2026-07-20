import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #17 — campaign templates / cloning.
 * POST /campaigns/:id/clone duplicates a campaign ('full', default) or copies
 * prep only ('template'). Cross-references (quest giver, npc location, note
 * entity links, currentLocationId, combatant character) must be remapped to
 * the cloned rows' new ids, and members are never copied — only the caller
 * becomes the clone's dm.
 */
describe('campaign clone (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let locationId: number;
  let npcId: number;
  let questId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'clone-dm', password: 'dm-password-1' });

    const createPlayer = await dmAgent.post('/api/v1/users').send({ username: 'clone-player', password: 'player-password-1', serverRole: 'user' });
    const playerId = createPlayer.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'clone-player', password: 'player-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Origin Campaign', description: 'The one true prep.' });
    campaignId = campRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    // World prep with cross-references: location <- npc <- quest (giver).
    const locRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'Old Keep', dmSecret: 'haunted' });
    locationId = locRes.body.id;
    await dmAgent.post(`/api/v1/locations/${locationId}/discover`).send({ status: 'explored' });
    await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ currentLocationId: locationId });

    const npcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Bartender', locationId, dmSecret: 'secretly a lich' });
    npcId = npcRes.body.id;

    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'Main Quest', giverNpcId: npcId, dmSecret: 'the mayor did it' });
    questId = questRes.body.id;
    const objRes = await dmAgent.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Find the culprit' });
    await dmAgent.patch(`/api/v1/quests/${questId}/objectives/${objRes.body.id}`).send({ done: true });
    await dmAgent.post(`/api/v1/quests/${questId}/status`).send({ status: 'active' });

    // Play state: session, character, encounter+combatant, notes.
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ number: 1, recap: 'The party arrived.' });
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Hero', className: 'Fighter' });
    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Goblin Ambush' });
    await dmAgent.post(`/api/v1/encounters/${encRes.body.id}/combatants`).send({ kind: 'monster', name: 'Goblin', hpMax: 7 });

    await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Shared quest intel', visibility: 'party_shared', entityType: 'quest', entityId: questId });
    await playerAgent
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'My private player diary', visibility: 'private' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('full clone duplicates everything with references remapped', async () => {
    const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({});
    expect(res.status).toBe(201);
    const clone = res.body;
    expect(clone.id).not.toBe(campaignId);
    expect(clone.name).toBe('Origin Campaign (copy)');
    expect(clone.description).toBe('The one true prep.');
    expect(clone.sessionCount).toBe(1);
    expect(clone.mapAttachmentId).toBeNull();

    // Locations copied (status preserved), currentLocationId remapped to the cloned row.
    const locs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/locations`);
    expect(locs.body.length).toBe(1);
    expect(locs.body[0].id).not.toBe(locationId);
    expect(locs.body[0].name).toBe('Old Keep');
    expect(locs.body[0].status).toBe('explored');
    expect(locs.body[0].dmSecret).toBe('haunted');
    expect(clone.currentLocationId).toBe(locs.body[0].id);

    // NPCs copied with locationId remapped.
    const clonedNpcs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/npcs`);
    expect(clonedNpcs.body.length).toBe(1);
    expect(clonedNpcs.body[0].id).not.toBe(npcId);
    expect(clonedNpcs.body[0].locationId).toBe(locs.body[0].id);
    expect(clonedNpcs.body[0].dmSecret).toBe('secretly a lich');

    // Quests copied with giverNpcId remapped, status + objectives preserved.
    const clonedQuests = await dmAgent.get(`/api/v1/campaigns/${clone.id}/quests`);
    expect(clonedQuests.body.length).toBe(1);
    const q = clonedQuests.body[0];
    expect(q.id).not.toBe(questId);
    expect(q.status).toBe('active');
    expect(q.dmSecret).toBe('the mayor did it');
    expect(q.giverNpcId).toBe(clonedNpcs.body[0].id);
    expect(q.objectives.length).toBe(1);
    expect(q.objectives[0].done).toBe(true);

    // Sessions and characters copied.
    const sessions = await dmAgent.get(`/api/v1/campaigns/${clone.id}/sessions`);
    expect(sessions.body.length).toBe(1);
    expect(sessions.body[0].recap).toBe('The party arrived.');
    const chars = await dmAgent.get(`/api/v1/campaigns/${clone.id}/characters`);
    expect(chars.body.length).toBe(1);
    expect(chars.body[0].name).toBe('Hero');

    // Encounters copied with combatants (Hero was auto-added on encounter
    // create, so there are 2). The character combatant's characterId must be
    // remapped to the cloned character.
    const encs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/encounters`);
    expect(encs.body.length).toBe(1);
    const encDetail = await dmAgent.get(`/api/v1/encounters/${encs.body[0].id}`);
    expect(encDetail.body.combatants.length).toBe(2);
    const goblin = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Goblin');
    expect(goblin).toBeDefined();
    const hero = encDetail.body.combatants.find((c: { name: string }) => c.name === 'Hero');
    expect(hero.kind).toBe('character');
    expect(hero.characterId).toBe(chars.body[0].id);

    // Notes: shared note copied with its entity link remapped to the cloned
    // quest; the player's private note (invisible to the dm) is not carried over.
    const clonedNotes = await dmAgent.get(`/api/v1/campaigns/${clone.id}/notes`);
    const bodies = clonedNotes.body.map((n: { body: string }) => n.body);
    expect(bodies).toContain('Shared quest intel');
    expect(bodies).not.toContain('My private player diary');
    const shared = clonedNotes.body.find((n: { body: string }) => n.body === 'Shared quest intel');
    expect(shared.entityType).toBe('quest');
    expect(shared.entityId).toBe(q.id);

    // Members are NOT copied — the source player has no access to the clone.
    const playerView = await playerAgent.get(`/api/v1/campaigns/${clone.id}`);
    expect(playerView.status).toBe(403);
  });

  it('template clone copies prep only and resets play state', async () => {
    const res = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/clone`)
      .send({ name: 'Fresh Start', mode: 'template' });
    expect(res.status).toBe(201);
    const clone = res.body;
    expect(clone.name).toBe('Fresh Start');
    expect(clone.sessionCount).toBe(0);
    expect(clone.status).toBe('active');
    expect(clone.currentLocationId).toBeNull();

    // Prep copied, progress reset.
    const locs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/locations`);
    expect(locs.body.length).toBe(1);
    expect(locs.body[0].status).toBe('unexplored');
    const clonedNpcs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/npcs`);
    expect(clonedNpcs.body.length).toBe(1);
    expect(clonedNpcs.body[0].locationId).toBe(locs.body[0].id);
    const clonedQuests = await dmAgent.get(`/api/v1/campaigns/${clone.id}/quests`);
    expect(clonedQuests.body.length).toBe(1);
    expect(clonedQuests.body[0].status).toBe('available');
    expect(clonedQuests.body[0].objectives.length).toBe(1);
    expect(clonedQuests.body[0].objectives[0].done).toBe(false);

    // Play state stripped.
    const sessions = await dmAgent.get(`/api/v1/campaigns/${clone.id}/sessions`);
    expect(sessions.body.length).toBe(0);
    const chars = await dmAgent.get(`/api/v1/campaigns/${clone.id}/characters`);
    expect(chars.body.length).toBe(0);
    const encs = await dmAgent.get(`/api/v1/campaigns/${clone.id}/encounters`);
    expect(encs.body.length).toBe(0);
    const clonedNotes = await dmAgent.get(`/api/v1/campaigns/${clone.id}/notes`);
    expect(clonedNotes.body.length).toBe(0);
  });

  it('403 for player (non-dm) on the source campaign', async () => {
    const res = await playerAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({});
    expect(res.status).toBe(403);
  });

  it('400 on an unknown mode', async () => {
    const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/clone`).send({ mode: 'partial' });
    expect(res.status).toBe(400);
  });
});
