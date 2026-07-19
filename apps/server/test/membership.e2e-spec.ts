import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('membership + effective roles (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userA: ReturnType<typeof request.agent>;
  let userB: ReturnType<typeof request.agent>;
  let userBId: number;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin', password: 'admin-password-1' });

    await adminAgent.post('/api/v1/users').send({ username: 'user-a', password: 'password-a-1', serverRole: 'user' });
    const createB = await adminAgent.post('/api/v1/users').send({ username: 'user-b', password: 'password-b-1', serverRole: 'user' });
    userBId = createB.body.id;

    userA = request.agent(server);
    await userA.post('/api/v1/auth/login').send({ username: 'user-a', password: 'password-a-1' });

    userB = request.agent(server);
    await userB.post('/api/v1/auth/login').send({ username: 'user-b', password: 'password-b-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('user A creates a campaign and is auto-inserted as dm', async () => {
    const createRes = await userA.post('/api/v1/campaigns').send({ name: 'The Sunken Keep' });
    expect(createRes.status).toBe(201);
    campaignId = createRes.body.id;

    const meRes = await userA.get('/api/v1/me');
    expect(meRes.body.memberships.some((m: { campaignId: number; role: string }) => m.campaignId === campaignId && m.role === 'dm')).toBe(true);
  });

  it('user B (not a member) gets 403 on GET campaign', async () => {
    const res = await userB.get(`/api/v1/campaigns/${campaignId}`);
    expect(res.status).toBe(403);
  });

  it('A adds B as player; B can then read the campaign', async () => {
    const addRes = await userA.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: userBId, role: 'player' });
    expect(addRes.status).toBe(201);
    expect(addRes.body.role).toBe('player');
    expect(addRes.body.username).toBe('user-b');

    const getRes = await userB.get(`/api/v1/campaigns/${campaignId}`);
    expect(getRes.status).toBe(200);
  });

  it('B (player) cannot create a quest (403)', async () => {
    const res = await userB.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Should fail' });
    expect(res.status).toBe(403);
  });

  it('B can tick an objective on a quest A creates', async () => {
    const questRes = await userA.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Clear the cellar' });
    expect(questRes.status).toBe(201);
    const questId = questRes.body.id;

    const objRes = await userA.post(`/api/v1/quests/${questId}/objectives`).send({ text: 'Find the trapdoor' });
    expect(objRes.status).toBe(201);
    const objectiveId = objRes.body.id;

    const tickRes = await userB.patch(`/api/v1/quests/${questId}/objectives/${objectiveId}`).send({ done: true });
    expect(tickRes.status).toBe(200);
    expect(tickRes.body.done).toBe(true);
  });

  it('members list shows both A (dm) and B (player)', async () => {
    const res = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    expect(res.status).toBe(200);
    const roles = res.body.map((m: { role: string }) => m.role).sort();
    expect(roles).toEqual(['dm', 'player']);
  });

  it('removing the last dm is refused (409)', async () => {
    const membersRes = await userA.get(`/api/v1/campaigns/${campaignId}/members`);
    const dmMember = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    expect(dmMember).toBeDefined();

    const removeRes = await userA.delete(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`);
    expect(removeRes.status).toBe(409);

    const demoteRes = await userA.patch(`/api/v1/campaigns/${campaignId}/members/${dmMember.id}`).send({ role: 'player' });
    expect(demoteRes.status).toBe(409);
  });

  it('GET /campaigns scoping: admin sees all, user B sees only campaigns they are a member of', async () => {
    // A second campaign created by admin — B is not a member.
    const otherCampaign = await adminAgent.post('/api/v1/campaigns').send({ name: 'Admin-only campaign' });
    expect(otherCampaign.status).toBe(201);

    const adminList = await adminAgent.get('/api/v1/campaigns');
    expect(adminList.body.some((c: { id: number }) => c.id === campaignId)).toBe(true);
    expect(adminList.body.some((c: { id: number }) => c.id === otherCampaign.body.id)).toBe(true);

    const bList = await userB.get('/api/v1/campaigns');
    expect(bList.body.some((c: { id: number }) => c.id === campaignId)).toBe(true);
    expect(bList.body.some((c: { id: number }) => c.id === otherCampaign.body.id)).toBe(false);
  });
});

/**
 * Punch list item 2: deleting a user (admin-only DELETE /users/:id) used to cascade
 * campaign_members without the same last-dm guard MembersService's own DELETE endpoint
 * enforces (see the "removing the last dm is refused (409)" test above) — so deleting the
 * user row was a silent bypass that could orphan a campaign with zero dms. UsersService.remove()
 * now runs the same check across every campaign the target user dms.
 */
describe('user delete last-dm guard (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let soleDmAgent: ReturnType<typeof request.agent>;
  let soleDmId: number;
  let sharedDmAgent: ReturnType<typeof request.agent>;
  let sharedDmId: number;
  let coDmAgent: ReturnType<typeof request.agent>;
  let coDmId: number;
  let soleDmCampaignId: number;
  let sharedCampaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'del-admin', password: 'admin-password-1' });

    const soleDmCreate = await adminAgent.post('/api/v1/users').send({ username: 'sole-dm', password: 'sole-dm-password', serverRole: 'user' });
    soleDmId = soleDmCreate.body.id;
    soleDmAgent = request.agent(server);
    await soleDmAgent.post('/api/v1/auth/login').send({ username: 'sole-dm', password: 'sole-dm-password' });

    const sharedDmCreate = await adminAgent.post('/api/v1/users').send({ username: 'shared-dm', password: 'shared-dm-password', serverRole: 'user' });
    sharedDmId = sharedDmCreate.body.id;
    sharedDmAgent = request.agent(server);
    await sharedDmAgent.post('/api/v1/auth/login').send({ username: 'shared-dm', password: 'shared-dm-password' });

    const coDmCreate = await adminAgent.post('/api/v1/users').send({ username: 'co-dm', password: 'co-dm-password', serverRole: 'user' });
    coDmId = coDmCreate.body.id;
    coDmAgent = request.agent(server);
    await coDmAgent.post('/api/v1/auth/login').send({ username: 'co-dm', password: 'co-dm-password' });

    // sole-dm is the ONLY dm of this campaign — deleting them should be refused.
    const soleCampRes = await soleDmAgent.post('/api/v1/campaigns').send({ name: 'Sole DM Campaign' });
    soleDmCampaignId = soleCampRes.body.id;

    // shared-dm campaign has a second dm (co-dm) — deleting shared-dm should be allowed.
    const sharedCampRes = await sharedDmAgent.post('/api/v1/campaigns').send({ name: 'Shared DM Campaign' });
    sharedCampaignId = sharedCampRes.body.id;
    const membersRes = await sharedDmAgent.get(`/api/v1/campaigns/${sharedCampaignId}/members`);
    const sharedDmMemberRow = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    const promoteRes = await sharedDmAgent
      .post(`/api/v1/campaigns/${sharedCampaignId}/members`)
      .send({ userId: coDmId, role: 'dm' });
    expect(promoteRes.status).toBe(201);
    expect(sharedDmMemberRow.role).toBe('dm');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('deleting the sole dm of a campaign is refused (409, names the campaign)', async () => {
    const res = await adminAgent.delete(`/api/v1/users/${soleDmId}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Sole DM Campaign');

    // user still exists and can still log in
    const stillThere = await adminAgent.get('/api/v1/users');
    expect(stillThere.body.some((u: { id: number }) => u.id === soleDmId)).toBe(true);
  });

  it('deleting a dm who shares dm duties with another dm succeeds (204)', async () => {
    const res = await adminAgent.delete(`/api/v1/users/${sharedDmId}`);
    expect(res.status).toBe(204);

    const listRes = await adminAgent.get('/api/v1/users');
    expect(listRes.body.some((u: { id: number }) => u.id === sharedDmId)).toBe(false);

    // co-dm remains the sole dm now, campaign still reachable
    const campRes = await coDmAgent.get(`/api/v1/campaigns/${sharedCampaignId}`);
    expect(campRes.status).toBe(200);
  });

  it('after reassigning a co-dm, deleting the original sole dm now succeeds', async () => {
    const membersRes = await soleDmAgent.get(`/api/v1/campaigns/${soleDmCampaignId}/members`);
    const soleDmMemberRow = membersRes.body.find((m: { role: string }) => m.role === 'dm');
    expect(soleDmMemberRow).toBeDefined();

    const addCoDm = await soleDmAgent.post(`/api/v1/campaigns/${soleDmCampaignId}/members`).send({ userId: coDmId, role: 'dm' });
    expect(addCoDm.status).toBe(201);

    const res = await adminAgent.delete(`/api/v1/users/${soleDmId}`);
    expect(res.status).toBe(204);
  });
});
