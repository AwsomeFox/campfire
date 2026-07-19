import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * P1: admin provisioning (POST /users/:id/tokens, server-admin only) — mints a
 * PAT on behalf of another user so a DM/admin agent can provision an entire
 * table's worth of tokens without ever knowing player passwords. scope/campaignId
 * are validated against the TARGET user's own access (via TokensService.mintFor()),
 * not the admin's — see UsersController.mintToken().
 */
describe('POST /users/:id/tokens — admin token provisioning (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaignId: number;
  let otherCampaignId: number;
  let playerCharacterId: number;
  let otherCharacterId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'provision-admin', password: 'admin-password-1' });

    const createPlayerRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'provision-player', password: 'player-password-1', serverRole: 'user' });
    playerId = createPlayerRes.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'provision-player', password: 'player-password-1' });

    const campRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Provisioning Campaign' });
    campaignId = campRes.body.id;
    const otherCampRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Other Provisioning Campaign' });
    otherCampaignId = otherCampRes.body.id;

    await adminAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    // A character owned by the player, and one NOT owned by them (dm-managed / another owner) —
    // used to prove the minted token acts as the player (own writes ok, others 403).
    const ownCharRes = await adminAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Provision Player Character', ownerUserId: String(playerId) });
    playerCharacterId = ownCharRes.body.id;

    const otherCharRes = await adminAgent
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .send({ name: 'Someone Else Character', ownerUserId: 'not-the-player' });
    otherCharacterId = otherCharRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('admin mints a PAT for the player; it acts AS that player (own-character writes ok, others 403)', async () => {
    const server = ctx.app.getHttpServer();

    const mintRes = await adminAgent
      .post(`/api/v1/users/${playerId}/tokens`)
      .send({ tokenName: 'provisioned-for-player', scope: 'player', campaignId });
    expect(mintRes.status).toBe(201);
    expect(mintRes.body.token).toMatch(/^cf_pat_[0-9a-f]{48}$/);
    expect(mintRes.body.apiToken.userId).toBe(playerId);
    const rawToken = mintRes.body.token;

    // Acts as the player: /me reflects the player's identity, not the admin's.
    const meRes = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${rawToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe('provision-player');

    // Own-character write: ok.
    const ownWriteRes = await request(server)
      .patch(`/api/v1/characters/${playerCharacterId}`)
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ level: 3 });
    expect(ownWriteRes.status).toBe(200);
    expect(ownWriteRes.body.level).toBe(3);

    // Another player's character write: 403 (assertCanWrite in characters.service.ts).
    const otherWriteRes = await request(server)
      .patch(`/api/v1/characters/${otherCharacterId}`)
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ level: 3 });
    expect(otherWriteRes.status).toBe(403);
  });

  it('non-admin cannot provision tokens for other users -> 403', async () => {
    const res = await playerAgent
      .post(`/api/v1/users/${playerId}/tokens`)
      .send({ tokenName: 'self-provisioned', scope: 'player' });
    expect(res.status).toBe(403);
  });

  it("scope/campaignId are validated against the TARGET user's access, not the admin's", async () => {
    // The admin has full access to otherCampaignId, but the player is not a member of it.
    // Minting on the player's behalf, scoped to a campaign THEY cannot access, must 403 —
    // even though the admin themself could freely access otherCampaignId.
    const res = await adminAgent
      .post(`/api/v1/users/${playerId}/tokens`)
      .send({ tokenName: 'sneaky-admin-mint', scope: 'viewer', campaignId: otherCampaignId });
    expect(res.status).toBe(403);
  });

  it('scope defaults to viewer when omitted', async () => {
    const res = await adminAgent.post(`/api/v1/users/${playerId}/tokens`).send({ tokenName: 'default-scope-mint' });
    expect(res.status).toBe(201);
    expect(res.body.apiToken.scope).toBe('viewer');
  });

  it('unknown target user -> 404', async () => {
    const res = await adminAgent.post('/api/v1/users/999999/tokens').send({ tokenName: 'nope' });
    expect(res.status).toBe(404);
  });
});
