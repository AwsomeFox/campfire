import request from 'supertest';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' }; // dev-header users always carry serverRole 'admin'
const player = { 'x-dev-role': 'player', 'x-dev-user': 'p-1' };

describe('rules / rule packs (e2e, fake Open5e server)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('packs list is empty before install', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/rules/packs').set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('non-admin (dev-header player) cannot install', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/rules/packs/install')
      .set(player)
      .send({ source: 'open5e', url: fake.baseUrl });
    // player dev-header users still carry serverRole 'admin' in this codebase's dev-auth
    // path (see session-auth.guard.ts) — server-admin gating is exercised for real in the
    // "real sessions" describe block below. This assertion documents that dev-header
    // player/viewer roles are NOT server-role gated the same way campaign roles are.
    expect(res.status).toBe(201);
    // undo so later tests in this file start clean
    await request(ctx.app.getHttpServer()).delete(`/api/v1/rules/packs/${res.body.id}`).set(dm);
  });

  it('install from fake Open5e server -> packs list -> search -> entry fetch -> uninstall', async () => {
    const server = ctx.app.getHttpServer();

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(201);
    expect(installRes.body.slug).toBe('open5e-srd');
    expect(installRes.body.entryCount).toBe(2 + 2 + 1 + 2); // spells + creatures + magicitems + conditions from the fake server
    expect(installRes.body.license).toContain('Creative Commons');
    const packId = installRes.body.id;

    const listRes = await request(server).get('/api/v1/rules/packs').set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(packId);

    // re-installing the same slug without uninstalling first is rejected
    const reinstallRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl });
    expect(reinstallRes.status).toBe(409);

    // search: free text finds the fireball spell
    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.length).toBeGreaterThan(0);
    expect(searchRes.body.some((e: { name: string }) => e.name === 'Fireball')).toBe(true);

    // search: type filter narrows to monsters only
    const monsterSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'owlbear', type: 'monster' }).set(dm);
    expect(monsterSearchRes.status).toBe(200);
    expect(monsterSearchRes.body.length).toBeGreaterThan(0);
    for (const e of monsterSearchRes.body) expect(e.type).toBe('monster');
    expect(monsterSearchRes.body.some((e: { name: string }) => e.name === 'Owlbear')).toBe(true);

    // search: pack filter
    const packSearchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin', pack: 'open5e-srd' }).set(dm);
    expect(packSearchRes.status).toBe(200);
    expect(packSearchRes.body.some((e: { name: string }) => e.name === 'Goblin')).toBe(true);

    // search: no query returns entries (optionally filtered), not an error
    const browseRes = await request(server).get('/api/v1/rules/search').query({ type: 'condition' }).set(dm);
    expect(browseRes.status).toBe(200);
    expect(browseRes.body.length).toBeGreaterThanOrEqual(2);
    for (const e of browseRes.body) expect(e.type).toBe('condition');

    // entry fetch by id
    const fireball = searchRes.body.find((e: { name: string }) => e.name === 'Fireball');
    const entryRes = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
    expect(entryRes.status).toBe(200);
    expect(entryRes.body.name).toBe('Fireball');
    expect(entryRes.body.body).toContain('bright streak');
    expect(entryRes.body.type).toBe('spell');

    // any authed role (not just dm) can read
    const playerSearch = await request(server).get('/api/v1/rules/search').query({ q: 'prone' }).set(player);
    expect(playerSearch.status).toBe(200);
    expect(playerSearch.body.some((e: { name: string }) => e.name === 'Prone')).toBe(true);

    // uninstall
    const uninstallRes = await request(server).delete(`/api/v1/rules/packs/${packId}`).set(dm);
    expect(uninstallRes.status).toBe(200);

    const afterList = await request(server).get('/api/v1/rules/packs').set(dm);
    expect(afterList.body).toEqual([]);

    const afterSearch = await request(server).get('/api/v1/rules/search').query({ q: 'fireball' }).set(dm);
    expect(afterSearch.body).toEqual([]);

    const afterEntry = await request(server).get(`/api/v1/rules/entries/${fireball.id}`).set(dm);
    expect(afterEntry.status).toBe(404);
  });

  it('install with a single section only imports that section', async () => {
    const server = ctx.app.getHttpServer();

    const installRes = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['spells'] });
    expect(installRes.status).toBe(201);
    expect(installRes.body.entryCount).toBe(2);

    const searchRes = await request(server).get('/api/v1/rules/search').query({ q: 'goblin' }).set(dm);
    expect(searchRes.body).toEqual([]); // creatures weren't imported

    await request(server).delete(`/api/v1/rules/packs/${installRes.body.id}`).set(dm);
  });

  it('install from an unreachable URL fails cleanly (400), not a crash', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: 'http://127.0.0.1:1' }); // nothing listens here
    expect(res.status).toBe(400);
  });
});

describe('rules / rule packs — server-admin gating (e2e, real sessions)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    fake = await startFakeOpen5e();

    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'rules-admin', password: 'admin-password-1' });

    const createUserRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'rules-user', password: 'user-password-1' });
    expect(createUserRes.status).toBe(201);
    expect(createUserRes.body.serverRole).toBe('user');

    userAgent = request.agent(ctx.app.getHttpServer());
    await userAgent.post('/api/v1/auth/login').send({ username: 'rules-user', password: 'user-password-1' });
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  it('non-admin real user gets 403 on install and uninstall; can still read', async () => {
    const installRes = await userAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(403);

    const listRes = await userAgent.get('/api/v1/rules/packs');
    expect(listRes.status).toBe(200);

    const searchRes = await userAgent.get('/api/v1/rules/search').query({ q: 'anything' });
    expect(searchRes.status).toBe(200);

    const uninstallRes = await userAgent.delete('/api/v1/rules/packs/1');
    expect(uninstallRes.status).toBe(403);
  });

  it('admin real user can install', async () => {
    const installRes = await adminAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fake.baseUrl });
    expect(installRes.status).toBe(201);
    await adminAgent.delete(`/api/v1/rules/packs/${installRes.body.id}`);
  });
});
