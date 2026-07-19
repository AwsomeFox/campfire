import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

describe('auth setup/login/logout (e2e, real cookie sessions, DEV_AUTH unset)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('status -> setup -> me -> status(false) -> second setup 409', async () => {
    const server = ctx.app.getHttpServer();
    const agent = request.agent(server);

    const status1 = await agent.get('/api/v1/auth/status');
    expect(status1.status).toBe(200);
    expect(status1.body.setupRequired).toBe(true);
    expect(status1.body.localLoginEnabled).toBe(true);
    expect(status1.body.oidcEnabled).toBe(false);

    const setupRes = await agent
      .post('/api/v1/auth/setup')
      .send({ username: 'admin', password: 'correct-horse-battery', displayName: 'Admin' });
    expect(setupRes.status).toBe(201);
    expect(setupRes.body.user.username).toBe('admin');
    expect(setupRes.body.user.serverRole).toBe('admin');
    expect(setupRes.body.user.passwordHash).toBeUndefined();
    expect(setupRes.headers['set-cookie']).toBeDefined();

    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe('admin');
    expect(Array.isArray(meRes.body.memberships)).toBe(true);

    const status2 = await agent.get('/api/v1/auth/status');
    expect(status2.body.setupRequired).toBe(false);

    const secondSetup = await agent
      .post('/api/v1/auth/setup')
      .send({ username: 'someoneelse', password: 'another-password-1' });
    expect(secondSetup.status).toBe(409);
  });

  it('unauthenticated GET /me -> 401', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get('/api/v1/me');
    expect(res.status).toBe(401);
  });
});

describe('login/logout + wrong password (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const agent = request.agent(ctx.app.getHttpServer());
    await agent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('wrong password -> 401 generic', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/auth/login').send({ username: 'admin', password: 'nope-wrong' });
    expect(res.status).toBe(401);
  });

  it('correct login -> cookie -> me -> logout -> me 401', async () => {
    const server = ctx.app.getHttpServer();
    const agent = request.agent(server);

    const loginRes = await agent.post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-password-1' });
    expect(loginRes.status).toBe(201);
    expect(loginRes.body.user.username).toBe('admin');

    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);

    const logoutRes = await agent.post('/api/v1/auth/logout');
    expect(logoutRes.status).toBe(204);

    const meAfterLogout = await agent.get('/api/v1/me');
    expect(meAfterLogout.status).toBe(401);
  });
});

describe('allowLocalLogin=false blocks non-admin but not admin (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });

    // Admin creates a regular user via the users admin API.
    const createUserRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'regular', password: 'regular-password-1', serverRole: 'user' });
    expect(createUserRes.status).toBe(201);

    const settingsRes = await adminAgent.patch('/api/v1/settings').send({ allowLocalLogin: false });
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.allowLocalLogin).toBe(false);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('non-admin login is blocked (403) while allowLocalLogin=false', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/auth/login').send({ username: 'regular', password: 'regular-password-1' });
    expect(res.status).toBe(403);
  });

  it('admin may still log in (lockout prevention)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin-password-1' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('admin');
  });
});

describe('last-admin protection (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let adminId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    const setupRes = await adminAgent.post('/api/v1/auth/setup').send({ username: 'onlyadmin', password: 'admin-password-1' });
    adminId = setupRes.body.user.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('cannot demote the last admin (409)', async () => {
    const res = await adminAgent.patch(`/api/v1/users/${adminId}`).send({ serverRole: 'user' });
    expect(res.status).toBe(409);
  });

  it('cannot disable the last admin (409)', async () => {
    const res = await adminAgent.patch(`/api/v1/users/${adminId}`).send({ disabled: true });
    expect(res.status).toBe(409);
  });

  it('cannot delete the last admin (409)', async () => {
    const res = await adminAgent.delete(`/api/v1/users/${adminId}`);
    expect(res.status).toBe(409);
  });

  it('adding a second admin allows demoting the first', async () => {
    const createRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'secondadmin', password: 'admin-password-2', serverRole: 'admin' });
    expect(createRes.status).toBe(201);

    const demoteRes = await adminAgent.patch(`/api/v1/users/${adminId}`).send({ serverRole: 'user' });
    expect(demoteRes.status).toBe(200);
    expect(demoteRes.body.serverRole).toBe('user');
  });
});

describe('me/password (e2e)', () => {
  let ctx: TestAppContext;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    agent = request.agent(ctx.app.getHttpServer());
    await agent.post('/api/v1/auth/setup').send({ username: 'pwuser', password: 'original-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('wrong current password -> 400/403', async () => {
    const res = await agent.post('/api/v1/me/password').send({ currentPassword: 'nope', newPassword: 'new-password-99' });
    expect([400, 403]).toContain(res.status);
  });

  it('correct current password -> 204, kills other sessions, new password works on fresh login', async () => {
    const server = ctx.app.getHttpServer();

    // Start a second session for the same user (simulating another device).
    const otherSessionAgent = request.agent(server);
    const otherLogin = await otherSessionAgent.post('/api/v1/auth/login').send({ username: 'pwuser', password: 'original-password-1' });
    expect(otherLogin.status).toBe(201);
    const otherMeBefore = await otherSessionAgent.get('/api/v1/me');
    expect(otherMeBefore.status).toBe(200);

    const changeRes = await agent
      .post('/api/v1/me/password')
      .send({ currentPassword: 'original-password-1', newPassword: 'new-password-99' });
    expect(changeRes.status).toBe(204);

    // The OTHER session should now be dead.
    const otherMeAfter = await otherSessionAgent.get('/api/v1/me');
    expect(otherMeAfter.status).toBe(401);

    // The session that made the change survives.
    const selfMeAfter = await agent.get('/api/v1/me');
    expect(selfMeAfter.status).toBe(200);

    // Old password no longer works; new one does.
    const oldLogin = await request(server).post('/api/v1/auth/login').send({ username: 'pwuser', password: 'original-password-1' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(server).post('/api/v1/auth/login').send({ username: 'pwuser', password: 'new-password-99' });
    expect(newLogin.status).toBe(201);
  });
});
