import request from 'supertest';
import { and, count, eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaignInvites, campaignMembers, campaigns } from '../src/db/schema';
import { InvitesService } from '../src/modules/membership/invites.service';
import { UsersService } from '../src/modules/users/users.service';
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

describe('issue #655: maxUses TOCTOU — interleaved accepts never exceed the cap (service layer, real SQLite)', () => {
  // This is the deterministic regression guard for the race. The public HTTP
  // endpoint is exercised end-to-end by the suites above; here we drive the
  // service directly so the two contenders provably interleave at every await
  // boundary (better-sqlite3 queries resolve on a microtask, so `Promise.all` of
  // two service calls lets each run up to its first await before the other
  // starts — exactly the window the old read-then-write code lost). An HTTP-level
  // `Promise.all` of N accepts does NOT reliably reproduce the bug: Node's event
  // loop + supertest's per-request connection lifecycle serialise the work enough
  // that the race window often closes before a second contender reads, so the
  // old code would sporadically pass — a flaky regression test is worse than none.
  let ctx: TestAppContext;
  let invites: InvitesService;
  let usersService: UsersService;
  let db: DrizzleDb;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    invites = ctx.app.get(InvitesService);
    usersService = ctx.app.get(UsersService);
    db = ctx.app.get<DrizzleDb>(DB);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function seedCampaignWithInvite(maxUses: number, role: 'player' | 'viewer' = 'player'): Promise<{
    campaignId: number;
    code: string;
    inviteId: number;
  }> {
    const dm = await usersService.create({ username: `dm-${Math.random().toString(36).slice(2)}`, password: 'dm-password-1', serverRole: 'user' });
    const ts = new Date().toISOString();
    const [campaign] = await db
      .insert(campaigns)
      .values({ name: 'Race', createdAt: ts, updatedAt: ts })
      .returning();
    await db
      .insert(campaignMembers)
      .values({ campaignId: campaign.id, userId: dm.id, role: 'dm', characterId: null, createdAt: ts, updatedAt: ts })
      .run();
    const [inv] = await db
      .insert(campaignInvites)
      .values({
        campaignId: campaign.id,
        code: `CODE-${campaign.id}-${Math.random().toString(36).slice(2)}`,
        role,
        createdByUserId: dm.id,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        maxUses,
        useCount: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    return { campaignId: campaign.id, code: inv.code, inviteId: inv.id };
  }

  it('two interleaved join() calls on a maxUses=1 invite seat exactly one; the loser gets 404 and useCount stays at 1', async () => {
    const { code, inviteId, campaignId } = await seedCampaignWithInvite(1);
    const u1 = await usersService.create({ username: 'race-u1', password: 'u1-password-1', serverRole: 'user' });
    const u2 = await usersService.create({ username: 'race-u2', password: 'u2-password-1', serverRole: 'user' });

    const reqUser = (id: number) => ({ id: String(id), name: `u${id}`, role: 'user' as const, serverRole: 'user' as const });
    // Fire both WITHOUT awaiting either first: they interleave at every internal
    // await. On the old (pre-fix) code both fulfilled and useCount landed at 2.
    const settled = await Promise.allSettled([
      invites.join(code, reqUser(u1.id)),
      invites.join(code, reqUser(u2.id)),
    ]);
    const winners = settled.filter((s) => s.status === 'fulfilled');

    // Exactly one seat — never two.
    expect(winners).toHaveLength(1);
    // The loser sees the same uniform 404 a sequential latecomer would.
    const loser = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(Error);
    expect(loser.reason.message).toBe('This invite link is invalid or no longer active');

    const [invite] = await db.select().from(campaignInvites).where(eq(campaignInvites.id, inviteId));
    expect(invite.useCount).toBe(1); // the cap — never 2
    expect(invite.maxUses).toBe(1);

    const [seats] = await db
      .select({ value: count() })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'player')));
    expect(seats.value).toBe(1); // exactly one membership — never two
  });

  it('two interleaved accept() calls on a maxUses=1 invite seat exactly one; the loser gets 404 and useCount stays at 1', async () => {
    const { inviteId, campaignId, code } = await seedCampaignWithInvite(1);
    // accept() mints a brand-new user account as part of the call, so the two
    // contenders don't share a pre-existing user. Local login is on by default.
    const settled = await Promise.allSettled([
      invites.accept(code, { username: 'race-accept-a', password: 'aa-password-1', displayName: 'A' }),
      invites.accept(code, { username: 'race-accept-b', password: 'bb-password-1', displayName: 'B' }),
    ]);
    const winners = settled.filter((s) => s.status === 'fulfilled');

    expect(winners).toHaveLength(1);
    const loser = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(Error);
    expect(loser.reason.message).toBe('This invite link is invalid or no longer active');

    const [invite] = await db.select().from(campaignInvites).where(eq(campaignInvites.id, inviteId));
    expect(invite.useCount).toBe(1);
    const [seats] = await db
      .select({ value: count() })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'player')));
    expect(seats.value).toBe(1);
  });

  it('an unlimited invite (maxUses null) seats both interleaved joiners — the cap guard does not over-restrict', async () => {
    const { inviteId, campaignId, code } = await seedCampaignWithInvite(1).then(async (r) => {
      // switch the seeded invite to unlimited
      await db.update(campaignInvites).set({ maxUses: null }).where(eq(campaignInvites.id, r.inviteId));
      return r;
    });
    const u1 = await usersService.create({ username: 'unlim-u1', password: 'u1-password-1', serverRole: 'user' });
    const u2 = await usersService.create({ username: 'unlim-u2', password: 'u2-password-1', serverRole: 'user' });
    const reqUser = (id: number) => ({ id: String(id), name: `u${id}`, role: 'user' as const, serverRole: 'user' as const });

    const settled = await Promise.allSettled([
      invites.join(code, reqUser(u1.id)),
      invites.join(code, reqUser(u2.id)),
    ]);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);

    const [invite] = await db.select().from(campaignInvites).where(eq(campaignInvites.id, inviteId));
    expect(invite.useCount).toBe(2);
    const [seats] = await db
      .select({ value: count() })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'player')));
    expect(seats.value).toBe(2);
  });

  it('a maxUses=3 invite seats exactly 3 of 5 interleaved joiners; the rest get 404', async () => {
    const { inviteId, campaignId, code } = await seedCampaignWithInvite(3);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await usersService.create({ username: `cap5-${i}`, password: `u${i}-password-1`, serverRole: 'user' });
      ids.push(u.id);
    }
    const reqUser = (id: number) => ({ id: String(id), name: `u${id}`, role: 'user' as const, serverRole: 'user' as const });

    const settled = await Promise.allSettled(ids.map((id) => invites.join(code, reqUser(id))));
    const winners = settled.filter((s) => s.status === 'fulfilled');
    const losers = settled.filter((s) => s.status === 'rejected');
    expect(winners).toHaveLength(3);
    expect(losers).toHaveLength(2);

    const [invite] = await db.select().from(campaignInvites).where(eq(campaignInvites.id, inviteId));
    expect(invite.useCount).toBe(3);
    const [seats] = await db
      .select({ value: count() })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'player')));
    expect(seats.value).toBe(3);
  });
});

