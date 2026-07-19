import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

describe('campaigns (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('CRUD roundtrip', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'The Sunless Citadel', description: 'A classic.' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('The Sunless Citadel');
    expect(createRes.body.sessionCount).toBe(0);
    const id = createRes.body.id;

    const listRes = await request(server).get('/api/v1/campaigns').set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c: { id: number }) => c.id === id)).toBe(true);

    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(id);

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ description: 'Updated description' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.description).toBe('Updated description');

    const deleteRes = await request(server).delete(`/api/v1/campaigns/${id}`).set(dm);
    expect(deleteRes.status).toBe(200);

    const getAfterDelete = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getAfterDelete.status).toBe(404);
  });

  it('ruleSystem defaults to empty string and passes through create + PATCH', async () => {
    const server = ctx.app.getHttpServer();

    const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Rule System Test' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.ruleSystem).toBe('');
    const id = createRes.body.id;

    const createWithRuleSystem = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Rule System Test 2', ruleSystem: 'dnd5e-srd' });
    expect(createWithRuleSystem.status).toBe(201);
    expect(createWithRuleSystem.body.ruleSystem).toBe('dnd5e-srd');

    const patchRes = await request(server)
      .patch(`/api/v1/campaigns/${id}`)
      .set(dm)
      .send({ ruleSystem: 'dnd5e-srd' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ruleSystem).toBe('dnd5e-srd');

    const getRes = await request(server).get(`/api/v1/campaigns/${id}`).set(dm);
    expect(getRes.body.ruleSystem).toBe('dnd5e-srd');
  });

  it('GET /campaigns/:id/summary returns aggregate shape', async () => {
    const server = ctx.app.getHttpServer();
    const createRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Summary Test' });
    const id = createRes.body.id;

    const summaryRes = await request(server).get(`/api/v1/campaigns/${id}/summary`).set(dm);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.campaign.id).toBe(id);
    expect(summaryRes.body.currentLocation).toBeNull();
    expect(Array.isArray(summaryRes.body.quests)).toBe(true);
    expect(Array.isArray(summaryRes.body.npcs)).toBe(true);
    expect(Array.isArray(summaryRes.body.locations)).toBe(true);
    expect(Array.isArray(summaryRes.body.characters)).toBe(true);
    expect(Array.isArray(summaryRes.body.sessions)).toBe(true);
    expect(summaryRes.body.openInboxCount).toBe(0);
  });

  it('POST /campaigns is open to any authenticated user (dev-auth headers count), not just dm', async () => {
    // Under the membership model, campaign creation itself is unrestricted for any
    // authenticated caller — the creator is auto-inserted as that campaign's 'dm'.
    // The old "dm role required" behavior is superseded by per-campaign membership.
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set({ 'x-dev-role': 'player', 'x-dev-user': 'p1' })
      .send({ name: 'Player-created campaign' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Player-created campaign');
  });

  it('POST /campaigns 400s on invalid body (zod validation)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({});
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
  });
});

// Minimal valid 1x1 PNG (smallest possible real PNG payload) — same fixture as attachments.e2e-spec.ts.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

/**
 * Full cascade delete (punch list item 1). Builds a "rich" campaign touching every
 * child table the old single-row DELETE left orphaned — quest+objective, npc, location,
 * character, encounter+combatant, note, proposal, a second member, a campaign-bound API
 * token, and an uploaded attachment (DB row + on-disk file) — then deletes the campaign
 * and verifies every child 404s, the ex-member is locked out everywhere, and the
 * attachment's upload directory is gone from disk.
 */
describe('campaign delete cascade (e2e)', () => {
  let ctx: TestAppContext;
  let dmAgent: ReturnType<typeof request.agent>;
  let memberAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let questId: number;
  let objectiveId: number;
  let npcId: number;
  let locationId: number;
  let characterId: number;
  let encounterId: number;
  let combatantId: number;
  let noteId: number;
  let proposalId: number;
  let memberRowId: number;
  let memberUserId: number;
  let tokenId: number;
  let tokenRaw: string;
  let attachmentId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'cascade-dm', password: 'dm-password-1' });
    await dmAgent.post('/api/v1/users').send({ username: 'cascade-member', password: 'member-password-1', serverRole: 'user' });

    memberAgent = request.agent(server);
    await memberAgent.post('/api/v1/auth/login').send({ username: 'cascade-member', password: 'member-password-1' });

    const meRes = await memberAgent.get('/api/v1/me');
    memberUserId = meRes.body.user.id;

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Rich Doomed Campaign' });
    campaignId = campRes.body.id;

    // second member, added by the dm
    const memberRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: memberUserId, role: 'player' });
    expect(memberRes.status).toBe(201);
    memberRowId = memberRes.body.id;

    const questRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Doomed Quest' });
    questId = questRes.body.id;
    const objRes = await dmAgent.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Doomed Objective' });
    objectiveId = objRes.body.id;

    const npcRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/npcs`).send({ name: 'Doomed NPC' });
    npcId = npcRes.body.id;

    const locRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/locations`).send({ name: 'Doomed Location' });
    locationId = locRes.body.id;

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Doomed Character' });
    characterId = charRes.body.id;

    const encRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/encounters`).send({ name: 'Doomed Encounter' });
    encounterId = encRes.body.id;
    const combatantRes = await dmAgent.post(`/api/v1/encounters/${encounterId}/combatants`).send({ kind: 'monster', name: 'Doomed Monster', hpMax: 10 });
    combatantId = combatantRes.body.id;

    const noteRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/notes`).send({ body: 'Doomed note', visibility: 'party_shared' });
    noteId = noteRes.body.id;

    const proposalRes = await memberAgent.post(`/api/v1/campaigns/${campaignId}/quests?proposed=true`).send({ title: 'Doomed Proposal' });
    expect(proposalRes.status).toBe(202);
    proposalId = proposalRes.body.proposal.id;

    const tokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'cascade-token', scope: 'dm', campaignId });
    tokenId = tokenRes.body.apiToken.id;
    tokenRaw = tokenRes.body.token;

    const uploadRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'doomed.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    attachmentId = uploadRes.body.id;

    // Confirm the file actually landed on disk before we delete anything, so the
    // "directory is gone" assertion below is meaningful (not vacuously true).
    const uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    expect(fs.existsSync(uploadDir)).toBe(true);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('dm deletes the campaign', async () => {
    const res = await dmAgent.delete(`/api/v1/campaigns/${campaignId}`);
    expect(res.status).toBe(200);
  });

  it('campaign itself 404s', async () => {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect(res.status).toBe(404);
  });

  it('quest and its objective 404 (objective 404s via the quest lookup, not directly listable)', async () => {
    const questRes = await dmAgent.get(`/api/v1/quests/${questId}`);
    expect(questRes.status).toBe(404);
    // objective route requires the quest to resolve first, so it 404s the same way
    const objRes = await dmAgent.patch(`/api/v1/quests/${questId}/objectives/${objectiveId}`).send({ done: true });
    expect(objRes.status).toBe(404);
  });

  it('npc 404s', async () => {
    const res = await dmAgent.get(`/api/v1/npcs/${npcId}`);
    expect(res.status).toBe(404);
  });

  it('location 404s', async () => {
    const res = await dmAgent.get(`/api/v1/locations/${locationId}`);
    expect(res.status).toBe(404);
  });

  it('character 404s', async () => {
    const res = await dmAgent.get(`/api/v1/characters/${characterId}`);
    expect(res.status).toBe(404);
  });

  it('encounter and its combatant 404', async () => {
    const encRes = await dmAgent.get(`/api/v1/encounters/${encounterId}`);
    expect(encRes.status).toBe(404);
    const combatantRes = await dmAgent.patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`).send({ hpDelta: -1 });
    expect(combatantRes.status).toBe(404);
  });

  it('note 404s', async () => {
    const res = await dmAgent.get(`/api/v1/notes/${noteId}`);
    expect(res.status).toBe(404);
  });

  it('proposal is gone (approve 404s rather than resolving against a dead campaign)', async () => {
    const res = await dmAgent.post(`/api/v1/proposals/${proposalId}/approve`).send({});
    expect(res.status).toBe(404);
  });

  it('attachment file GET 404s and the on-disk upload dir is gone', async () => {
    const res = await dmAgent.get(`/api/v1/attachments/${attachmentId}/file`);
    expect(res.status).toBe(404);

    const uploadDir = path.join(ctx.dataDir, 'uploads', String(campaignId));
    expect(fs.existsSync(uploadDir)).toBe(false);
  });

  it('ex-member gets 403/404 everywhere for the dead campaign', async () => {
    const getRes = await memberAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect([403, 404]).toContain(getRes.status);

    const questListRes = await memberAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect([403, 404]).toContain(questListRes.status);

    const memberMeRes = await memberAgent.get('/api/v1/me');
    expect(memberMeRes.body.memberships.some((m: { campaignId: number }) => m.campaignId === campaignId)).toBe(false);
  });

  it('the campaign-bound API token is revoked (401 as Bearer)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${tokenRaw}`);
    expect(res.status).toBe(401);

    // and no longer listed among the dm's own tokens
    const listRes = await dmAgent.get('/api/v1/tokens');
    expect(listRes.body.some((t: { id: number }) => t.id === tokenId)).toBe(false);
  });

  it('member row is gone (re-adding the same user to a fresh campaign works, proving no orphaned row)', async () => {
    const newCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Fresh Campaign After Cascade' });
    const newCampaignId = newCampRes.body.id;
    const addRes = await dmAgent.post(`/api/v1/campaigns/${newCampaignId}/members`).send({ userId: memberUserId, role: 'player' });
    expect(addRes.status).toBe(201);
    expect(addRes.body.id).not.toBe(memberRowId);
  });
});
