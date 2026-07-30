import request from 'supertest';
import { closeTestApp, createTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'catch-up-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'catch-up-player' };

describe('catch-up: since you were last here (#549, e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Catch-up Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const getCatchUp = (headers: Record<string, string>, since?: string) => {
    const url = `/api/v1/campaigns/${campaignId}/catch-up${since ? `?since=${encodeURIComponent(since)}` : ''}`;
    return request(ctx.app.getHttpServer()).get(url).set(headers);
  };

  it('no sessions and no cursor -> empty diff', async () => {
    const res = await getCatchUp(dm);
    expect(res.status).toBe(200);
    expect(res.body.since).toBeNull();
    expect(res.body.totalCount).toBe(0);
    expect(res.body.lastCaughtUpAt).toBeNull();
  });

  it('after a session, new quests appear in catch-up', async () => {
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 1, playedAt: '2020-01-01' });

    const quest = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Return quest' });
    expect(quest.status).toBe(201);

    const res = await getCatchUp(dm);
    expect(res.status).toBe(200);
    expect(res.body.since).toBe('2020-01-01');
    expect(res.body.quests.map((q: { quest: { title: string } }) => q.quest.title)).toContain('Return quest');
    expect(res.body.totalCount).toBeGreaterThan(0);
  });

  it('hidden quests never leak to players', async () => {
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dm)
      .send({ title: 'Secret quest', hidden: true });

    const res = await getCatchUp(player);
    expect(res.status).toBe(200);
    const titles = res.body.quests.map((q: { quest: { title: string } }) => q.quest.title);
    expect(titles).not.toContain('Secret quest');
  });

  it('?since= reopens an earlier catch-up window', async () => {
    const earlier = await getCatchUp(dm, '2000-01-01T00:00:00.000Z');
    expect(earlier.status).toBe(200);
    expect(earlier.body.since).toBe('2000-01-01T00:00:00.000Z');
    expect(earlier.body.totalCount).toBeGreaterThan(0);
  });
});

describe('catch-up cursor mark (real auth, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const admin = request.agent(ctx.app.getHttpServer());
    expect((await admin.post('/api/v1/auth/setup').send({ username: 'catchup-admin', password: 'admin-password-1' })).status).toBe(201);
    const userRes = await admin.post('/api/v1/users').send({ username: 'catchup-dm', password: 'dm-password-1', serverRole: 'user' });
    expect(userRes.status).toBe(201);
    dm = request.agent(ctx.app.getHttpServer());
    expect((await dm.post('/api/v1/auth/login').send({ username: 'catchup-dm', password: 'dm-password-1' })).status).toBe(201);
    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Cursor Campaign' });
    campaignId = campaign.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('mark caught up stores cursor; subsequent diff uses it', async () => {
    const mark = await dm
      .post(`/api/v1/campaigns/${campaignId}/catch-up/mark`)
      .send({ at: '2025-01-01T00:00:00.000Z' });
    expect(mark.status).toBe(201);
    expect(mark.body.lastCaughtUpAt).toBe('2025-01-01T00:00:00.000Z');

    const quiet = await dm.get(`/api/v1/campaigns/${campaignId}/catch-up`);
    expect(quiet.status).toBe(200);
    expect(quiet.body.since).toBe('2025-01-01T00:00:00.000Z');
    expect(quiet.body.lastCaughtUpAt).toBe('2025-01-01T00:00:00.000Z');
    expect(quiet.body.totalCount).toBe(0);
  });
});

describe('catch-up mark is exempt from the campaign archive gate (issue #1480)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const admin = request.agent(ctx.app.getHttpServer());
    expect((await admin.post('/api/v1/auth/setup').send({ username: 'archcatch-admin', password: 'admin-password-1' })).status).toBe(201);
    expect((await admin.post('/api/v1/users').send({ username: 'archcatch-dm', password: 'dm-password-1', serverRole: 'user' })).status).toBe(201);

    dm = request.agent(ctx.app.getHttpServer());
    expect((await dm.post('/api/v1/auth/login').send({ username: 'archcatch-dm', password: 'dm-password-1' })).status).toBe(201);

    // The creator is a campaign member (its DM). Archive it so shared writes are
    // read-only — the regression is that catch-up mark still works anyway.
    const campaign = await dm.post('/api/v1/campaigns').send({ name: 'Archived Catch-up Campaign' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    const archive = await dm.patch(`/api/v1/campaigns/${campaignId}`).send({ status: 'completed' });
    expect(archive.status).toBe(200);
    expect(archive.body.status).toBe('completed');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a member of an archived campaign can still mark catch-up and dismiss the banner (201, not 403)', async () => {
    // Regression (issue #1480): catch-up mark bumps only the caller's OWN
    // per-user read cursor (personal read-state, like a notification read
    // marker), so it is EXEMPT from the archive read-only gate. A 403 here
    // would trap the dashboard "since you were here" banner forever on a
    // paused/completed campaign. The archive gate is role-agnostic, so covering
    // it with the DM (a member) proves the exemption for any member.
    const mark = await dm.post(`/api/v1/campaigns/${campaignId}/catch-up/mark`).send({});
    expect(mark.status).toBe(201);
    expect(mark.body.lastCaughtUpAt).toBeTruthy();

    // The stored cursor is honored by the next GET — the banner stays dismissed.
    const quiet = await dm.get(`/api/v1/campaigns/${campaignId}/catch-up`);
    expect(quiet.status).toBe(200);
    expect(quiet.body.lastCaughtUpAt).toBe(mark.body.lastCaughtUpAt);
    expect(quiet.body.totalCount).toBe(0);
  });
});
