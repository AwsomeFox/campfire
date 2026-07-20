import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #9 pinning tests — admin ≠ auto-DM: privilege separation from campaign secrets.
 *
 * Previously RoleResolver.baseEffectiveRole() mapped serverRole==='admin' to an
 * implicit 'dm' in EVERY campaign (and accessibleCampaignIds() returned 'all'),
 * so a server admin silently saw every campaign's DM secrets. Now serverRole is
 * never consulted for campaign access: an admin manages users/settings/packs but
 * holds NO role in campaigns they aren't a member of — server power ≠ story access.
 */
describe('Issue #9: server admin is NOT auto-DM of campaigns they are not a member of (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let adminId: number;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let questId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // First user via setup -> the server admin.
    adminAgent = request.agent(server);
    const setupRes = await adminAgent.post('/api/v1/auth/setup').send({ username: 'sep-admin', password: 'admin-password-1' });
    adminId = setupRes.body.user.id;

    // An ordinary user who DMs their own campaign, with a DM-only secret in it.
    await adminAgent.post('/api/v1/users').send({ username: 'sep-dm', password: 'dm-password-1', serverRole: 'user' });
    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'sep-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Secrets of the Vale' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    const questRes = await dmAgent
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .send({ title: 'The Hidden Heir', dmSecret: 'The innkeeper IS the heir' });
    expect(questRes.status).toBe(201);
    questId = questRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('a non-member admin has no campaign access at all', () => {
    it("GET /campaigns does not list another user's campaign for the admin", async () => {
      const res = await adminAgent.get('/api/v1/campaigns');
      expect(res.status).toBe(200);
      expect(res.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    });

    it('GET /campaigns/:id -> 403 (not the old implicit-dm 200)', async () => {
      const res = await adminAgent.get(`/api/v1/campaigns/${campaignId}`);
      expect(res.status).toBe(403);
    });

    it('GET /campaigns/:id/summary -> 403', async () => {
      const res = await adminAgent.get(`/api/v1/campaigns/${campaignId}/summary`);
      expect(res.status).toBe(403);
    });

    it('the DM-secret-bearing quest list is unreachable -> 403', async () => {
      const res = await adminAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
      expect(res.status).toBe(403);
    });

    it('PATCH and DELETE /campaigns/:id -> 403 (admin cannot manage a campaign they are not dm of)', async () => {
      const patchRes = await adminAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ name: 'Hijacked' });
      expect(patchRes.status).toBe(403);
      const deleteRes = await adminAgent.delete(`/api/v1/campaigns/${campaignId}`);
      expect(deleteRes.status).toBe(403);
    });

    it('members endpoints -> 403; the admin cannot even add THEMSELVES as a member', async () => {
      const listRes = await adminAgent.get(`/api/v1/campaigns/${campaignId}/members`);
      expect(listRes.status).toBe(403);

      const selfInviteRes = await adminAgent
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: adminId, role: 'dm' });
      expect(selfInviteRes.status).toBe(403);
    });

    it("the admin cannot mint a PAT scoped to someone else's campaign -> 403", async () => {
      const res = await adminAgent
        .post('/api/v1/tokens')
        .send({ name: 'sneaky-campaign-scope', scope: 'dm', campaignId });
      expect(res.status).toBe(403);
    });

    it('an adminEnabled dm-scoped PAT still gets 403 on the campaign (server power ≠ story access)', async () => {
      const mintRes = await adminAgent
        .post('/api/v1/tokens')
        .send({ name: 'admin-enabled-but-not-member', scope: 'dm', adminEnabled: true });
      expect(mintRes.status).toBe(201);
      expect(mintRes.body.apiToken.adminEnabled).toBe(true);

      const server = ctx.app.getHttpServer();
      const campaignRes = await request(server)
        .get(`/api/v1/campaigns/${campaignId}`)
        .set('Authorization', `Bearer ${mintRes.body.token}`);
      expect(campaignRes.status).toBe(403);

      // ...while the same token still passes SERVER-admin gates (that's what adminEnabled is for).
      const settingsRes = await request(server).get('/api/v1/settings').set('Authorization', `Bearer ${mintRes.body.token}`);
      expect(settingsRes.status).toBe(200);
    });
  });

  describe('server-admin power itself is untouched', () => {
    it('the admin still manages users and settings', async () => {
      const usersRes = await adminAgent.get('/api/v1/users');
      expect(usersRes.status).toBe(200);

      const settingsRes = await adminAgent.get('/api/v1/settings');
      expect(settingsRes.status).toBe(200);
    });

    it('the admin can still create their OWN campaign and is auto-dm of it', async () => {
      const createRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Admin Own Table' });
      expect(createRes.status).toBe(201);

      const getRes = await adminAgent.get(`/api/v1/campaigns/${createRes.body.id}`);
      expect(getRes.status).toBe(200);

      const questRes = await adminAgent
        .post(`/api/v1/campaigns/${createRes.body.id}/quests`)
        .send({ title: 'Admin quest', dmSecret: 'their own secret' });
      expect(questRes.status).toBe(201);
      expect(questRes.body.dmSecret).toBe('their own secret');
    });
  });

  describe('an admin added as a member gets exactly the granted role — no more', () => {
    let adminMemberId: number;

    it('DM adds the admin as player -> admin can read, but DM secrets stay redacted', async () => {
      const addRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: adminId, role: 'player' });
      expect(addRes.status).toBe(201);
      adminMemberId = addRes.body.id;

      const getRes = await adminAgent.get(`/api/v1/campaigns/${campaignId}`);
      expect(getRes.status).toBe(200);

      const questsRes = await adminAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
      expect(questsRes.status).toBe(200);
      const quest = questsRes.body.find((q: { id: number }) => q.id === questId);
      expect(quest).toBeDefined();
      expect(quest.dmSecret).toBe('');
    });

    it('as player the admin still cannot do dm-only things (create a quest) -> 403', async () => {
      const res = await adminAgent.post(`/api/v1/campaigns/${campaignId}/quests`).send({ title: 'Should fail' });
      expect(res.status).toBe(403);
    });

    it('promoted to dm BY the DM, the admin now sees the secret — membership, not serverRole, is what grants it', async () => {
      const promoteRes = await dmAgent.patch(`/api/v1/campaigns/${campaignId}/members/${adminMemberId}`).send({ role: 'dm' });
      expect(promoteRes.status).toBe(200);

      const questsRes = await adminAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
      expect(questsRes.status).toBe(200);
      const quest = questsRes.body.find((q: { id: number }) => q.id === questId);
      expect(quest.dmSecret).toBe('The innkeeper IS the heir');
    });

    it('and once removed again, access is gone', async () => {
      const removeRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/members/${adminMemberId}`);
      expect(removeRes.status).toBe(204);

      const getRes = await adminAgent.get(`/api/v1/campaigns/${campaignId}`);
      expect(getRes.status).toBe(403);

      const listRes = await adminAgent.get('/api/v1/campaigns');
      expect(listRes.body.some((c: { id: number }) => c.id === campaignId)).toBe(false);
    });
  });
});
