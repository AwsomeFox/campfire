import request from 'supertest';
import { count, eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaignInvites } from '../src/db/schema';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('campaign invites / join codes (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'root-admin', password: 'admin-password-1' });

    await adminAgent.post('/api/v1/users').send({ username: 'dm-dana', password: 'dm-password-1', serverRole: 'user' });
    await adminAgent.post('/api/v1/users').send({ username: 'player-pat', password: 'pat-password-1', serverRole: 'user' });

    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'dm-dana', password: 'dm-password-1' });

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'player-pat', password: 'pat-password-1' });

    const campaignRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'The Ember Vale' });
    campaignId = campaignRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('DM management endpoints', () => {
    let inviteId: number;
    let inviteCode: string;

    it('DM creates an invite link (defaults: player role, 7-day expiry, unlimited uses)', async () => {
      const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({});
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('player');
      expect(res.body.campaignId).toBe(campaignId);
      expect(res.body.maxUses).toBeNull();
      expect(res.body.useCount).toBe(0);
      expect(typeof res.body.code).toBe('string');
      expect(res.body.code.length).toBeGreaterThanOrEqual(20); // 16 random bytes base64url
      // ~7 days out
      const msLeft = new Date(res.body.expiresAt).getTime() - Date.now();
      expect(msLeft).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(msLeft).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
      inviteId = res.body.id;
      inviteCode = res.body.code;
    });

    it('invite list shows the live invite (with code)', async () => {
      const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      expect(res.status).toBe(200);
      expect(res.body.some((i: { id: number; code: string }) => i.id === inviteId && i.code === inviteCode)).toBe(true);
    });

    it('creating an invite with role "dm" is rejected (400) — invites never grant dm', async () => {
      const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'dm' });
      expect(res.status).toBe(400);
    });

    it('a player cannot create or list invites (403)', async () => {
      await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({
        userId: (await adminAgent.get('/api/v1/users')).body.find((u: { username: string }) => u.username === 'player-pat').id,
        role: 'player',
      });
      const createRes = await playerAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({});
      expect(createRes.status).toBe(403);
      const listRes = await playerAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      expect(listRes.status).toBe(403);
    });

    it('a non-member cannot create invites (403)', async () => {
      const otherCampaign = await adminAgent.post('/api/v1/campaigns').send({ name: 'Not yours' });
      const res = await dmAgent.post(`/api/v1/campaigns/${otherCampaign.body.id}/invites`).send({});
      expect(res.status).toBe(403);
    });

    it('DM revokes an invite; the code stops working', async () => {
      const revokeRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}/invites/${inviteId}`);
      expect(revokeRes.status).toBe(204);

      const previewRes = await request(ctx.app.getHttpServer()).get(`/api/v1/invites/${inviteCode}`);
      expect(previewRes.status).toBe(404);
    });
  });

  describe('public preview + accept (new account)', () => {
    let code: string;

    beforeAll(async () => {
      const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'player' });
      code = res.body.code;
    });

    it('anonymous preview resolves campaign name + role', async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/invites/${code}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ campaignId, campaignName: 'The Ember Vale', role: 'player' }),
      );
    });

    it('an unknown code previews as 404', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/invites/definitely-not-a-code');
      expect(res.status).toBe(404);
    });

    it('accept creates the account, joins the campaign, and starts a session', async () => {
      const newbie = request.agent(ctx.app.getHttpServer());
      const res = await newbie.post(`/api/v1/invites/${code}/accept`).send({
        username: 'new-nadia',
        password: 'nadia-password-1',
        displayName: 'Nadia',
      });
      expect(res.status).toBe(201);
      expect(res.body.campaignId).toBe(campaignId);
      expect(res.body.user.username).toBe('new-nadia');
      expect(res.body.user.serverRole).toBe('user');
      expect(res.body.memberships).toEqual([expect.objectContaining({ campaignId, role: 'player' })]);

      // Session cookie was set: /me works without logging in again.
      const meRes = await newbie.get('/api/v1/me');
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.username).toBe('new-nadia');

      // And the invite's use count ticked up.
      const listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      const invite = listRes.body.find((i: { code: string }) => i.code === code);
      expect(invite.useCount).toBe(1);
    });

    it('accept with a taken username is 409 and does not burn a use', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/invites/${code}/accept`)
        .send({ username: 'new-nadia', password: 'whatever-password-1' });
      expect(res.status).toBe(409);

      const listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      const invite = listRes.body.find((i: { code: string }) => i.code === code);
      expect(invite.useCount).toBe(1);
    });

    it('accept with a weak password is 400 (zod)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/invites/${code}/accept`)
        .send({ username: 'weak-willy', password: 'short' });
      expect(res.status).toBe(400);
    });

    it('accept is refused (403) while local login is disabled — no policy bypass', async () => {
      await adminAgent.patch('/api/v1/settings').send({ allowLocalLogin: false });
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/invites/${code}/accept`)
        .send({ username: 'blocked-bob', password: 'bob-password-1' });
      expect(res.status).toBe(403);
      await adminAgent.patch('/api/v1/settings').send({ allowLocalLogin: true });
    });
  });

  describe('join as an existing, signed-in user', () => {
    let viewerCode: string;
    let secondCampaignId: number;

    beforeAll(async () => {
      const campaignRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Side Quest Saturdays' });
      secondCampaignId = campaignRes.body.id;
      const res = await dmAgent.post(`/api/v1/campaigns/${secondCampaignId}/invites`).send({ role: 'viewer' });
      viewerCode = res.body.code;
    });

    it('unauthenticated join is 401 (accept is the anonymous path)', async () => {
      const res = await request(ctx.app.getHttpServer()).post(`/api/v1/invites/${viewerCode}/join`);
      expect(res.status).toBe(401);
    });

    it('a signed-in user joins at the invite role', async () => {
      const res = await playerAgent.post(`/api/v1/invites/${viewerCode}/join`);
      expect(res.status).toBe(201);
      expect(res.body.campaignId).toBe(secondCampaignId);
      expect(res.body.memberships).toEqual(
        expect.arrayContaining([expect.objectContaining({ campaignId: secondCampaignId, role: 'viewer' })]),
      );
    });

    it('joining a campaign you are already in is 409', async () => {
      const res = await playerAgent.post(`/api/v1/invites/${viewerCode}/join`);
      expect(res.status).toBe(409);
    });
  });

  describe('expiry + use caps', () => {
    it('a use-capped invite stops working once exhausted', async () => {
      const createRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'viewer', maxUses: 1 });
      const code = createRes.body.code;

      const first = await request(ctx.app.getHttpServer())
        .post(`/api/v1/invites/${code}/accept`)
        .send({ username: 'solo-sam', password: 'sam-password-1' });
      expect(first.status).toBe(201);

      const second = await request(ctx.app.getHttpServer())
        .post(`/api/v1/invites/${code}/accept`)
        .send({ username: 'late-lucy', password: 'lucy-password-1' });
      expect(second.status).toBe(404);

      // Exhausted invites are not shown in the DM's live-only list.
      const listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      expect(listRes.body.some((i: { code: string }) => i.code === code)).toBe(false);
    });

    it('an expired invite stops working (and is omitted from the list)', async () => {
      const createRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'player' });
      const code = createRes.body.code;

      // Time-travel: force the row's expiry into the past.
      const db = ctx.app.get<DrizzleDb>(DB);
      await db
        .update(campaignInvites)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(campaignInvites.code, code));

      const previewRes = await request(ctx.app.getHttpServer()).get(`/api/v1/invites/${code}`);
      expect(previewRes.status).toBe(404);

      const acceptRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/invites/${code}/accept`)
        .send({ username: 'tardy-tom', password: 'tom-password-1' });
      expect(acceptRes.status).toBe(404);

      const listRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      expect(listRes.body.some((i: { code: string }) => i.code === code)).toBe(false);
    });

    it('repeated live-invite GETs are byte-identical and retain expired/exhausted rows', async () => {
      const liveRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'player' });
      const expiredRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'viewer' });
      const exhaustedRes = await dmAgent
        .post(`/api/v1/campaigns/${campaignId}/invites`)
        .send({ role: 'player', maxUses: 1 });
      expect([liveRes.status, expiredRes.status, exhaustedRes.status]).toEqual([201, 201, 201]);

      const db = ctx.app.get<DrizzleDb>(DB);
      await db
        .update(campaignInvites)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(campaignInvites.id, expiredRes.body.id));
      await db
        .update(campaignInvites)
        .set({ useCount: exhaustedRes.body.maxUses })
        .where(eq(campaignInvites.id, exhaustedRes.body.id));

      const [{ value: countBefore }] = await db
        .select({ value: count() })
        .from(campaignInvites)
        .where(eq(campaignInvites.campaignId, campaignId));

      const first = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      const second = await dmAgent.get(`/api/v1/campaigns/${campaignId}/invites`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.text).toBe(second.text);
      expect(first.body.some((i: { id: number }) => i.id === liveRes.body.id)).toBe(true);
      expect(first.body.some((i: { id: number }) => i.id === expiredRes.body.id)).toBe(false);
      expect(first.body.some((i: { id: number }) => i.id === exhaustedRes.body.id)).toBe(false);

      const rowsAfter = await db
        .select()
        .from(campaignInvites)
        .where(eq(campaignInvites.campaignId, campaignId));
      expect(rowsAfter).toHaveLength(countBefore);
      expect(rowsAfter.some((row) => row.id === expiredRes.body.id)).toBe(true);
      expect(rowsAfter.some((row) => row.id === exhaustedRes.body.id)).toBe(true);
    });

    it('expiresInDays outside 1..365 is rejected (400)', async () => {
      const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ expiresInDays: 0 });
      expect(res.status).toBe(400);
    });
  });
});
