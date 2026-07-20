import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #8: optional self-service signup (POST /auth/signup, @Public), gated on
 * the admin-controlled `allowSignup` server setting (default OFF). See
 * AuthService.signup() / AuthController.signup() and GET /auth/status's
 * effective `signupEnabled` flag.
 */
describe('self-service signup is blocked before first-run setup (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('status reports signupEnabled=false while setupRequired', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.setupRequired).toBe(true);
    expect(res.body.signupEnabled).toBe(false);
  });

  it('POST /auth/signup before setup -> 409 (first admin must come from /auth/setup)', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ username: 'eager', password: 'eager-password-1' });
    expect(res.status).toBe(409);
  });
});

describe('self-service signup toggle (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('signup is OFF by default: status.signupEnabled=false, POST /auth/signup -> 403', async () => {
    const server = ctx.app.getHttpServer();

    const status = await request(server).get('/api/v1/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.setupRequired).toBe(false);
    expect(status.body.signupEnabled).toBe(false);

    const res = await request(server)
      .post('/api/v1/auth/signup')
      .send({ username: 'walkin', password: 'walkin-password-1' });
    expect(res.status).toBe(403);
  });

  it('GET /settings (admin) includes allowSignup=false default', async () => {
    const res = await adminAgent.get('/api/v1/settings');
    expect(res.status).toBe(200);
    expect(res.body.allowSignup).toBe(false);
    expect(res.body.allowLocalLogin).toBe(true);
  });

  it('non-admin cannot flip allowSignup (settings are admin-only)', async () => {
    // Create a regular user and try to PATCH /settings with their session.
    await adminAgent.post('/api/v1/users').send({ username: 'sneaky', password: 'sneaky-password-1', serverRole: 'user' });
    const userAgent = request.agent(ctx.app.getHttpServer());
    const login = await userAgent.post('/api/v1/auth/login').send({ username: 'sneaky', password: 'sneaky-password-1' });
    expect(login.status).toBe(201);

    const res = await userAgent.patch('/api/v1/settings').send({ allowSignup: true });
    expect(res.status).toBe(403);
  });

  it('admin enables allowSignup -> status.signupEnabled=true -> signup creates a working non-admin session', async () => {
    const server = ctx.app.getHttpServer();

    const patchRes = await adminAgent.patch('/api/v1/settings').send({ allowSignup: true });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.allowSignup).toBe(true);

    const status = await request(server).get('/api/v1/auth/status');
    expect(status.body.signupEnabled).toBe(true);

    const signupAgent = request.agent(server);
    const res = await signupAgent
      .post('/api/v1/auth/signup')
      .send({ username: 'newplayer', password: 'player-password-1', displayName: 'New Player' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('newplayer');
    expect(res.body.user.displayName).toBe('New Player');
    expect(res.body.user.serverRole).toBe('user');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.headers['set-cookie']).toBeDefined();

    // Session cookie works immediately.
    const meRes = await signupAgent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe('newplayer');
    expect(Array.isArray(meRes.body.memberships)).toBe(true);

    // And a fresh login with the chosen password works too.
    const relogin = await request(server).post('/api/v1/auth/login').send({ username: 'newplayer', password: 'player-password-1' });
    expect(relogin.status).toBe(201);
  });

  it('a serverRole field smuggled into the signup body cannot mint an admin', async () => {
    const server = ctx.app.getHttpServer();
    // SignupRequestDto is now .strict() (issue #131): an unsupported field like
    // `serverRole` is rejected outright (400, naming the key) rather than being
    // silently stripped and the account created as a plain 'user'. Either way no
    // admin is minted — strict just fails loud instead of quiet.
    const res = await request(server)
      .post('/api/v1/auth/signup')
      .send({ username: 'wannabe', password: 'wannabe-password-1', serverRole: 'admin' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/serverRole|[Uu]nrecognized/);

    // And no account was created for that username — a follow-up clean signup succeeds.
    const clean = await request(server)
      .post('/api/v1/auth/signup')
      .send({ username: 'wannabe', password: 'wannabe-password-1' });
    expect(clean.status).toBe(201);
    expect(clean.body.user.serverRole).toBe('user');
  });

  it('duplicate username -> 409', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ username: 'newplayer', password: 'another-password-1' });
    expect(res.status).toBe(409);
  });

  it('taken admin username -> 409 (same generic conflict)', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ username: 'admin', password: 'another-password-1' });
    expect(res.status).toBe(409);
  });

  it('short password (<8 chars) -> 400 from zod', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ username: 'shorty', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('oversized password (>200 chars) -> 400, before scrypt runs', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ username: 'longpass', password: 'x'.repeat(300) });
    expect(res.status).toBe(400);
  });

  it('invalid username characters -> 400 from zod', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .send({ username: 'not ok!', password: 'valid-password-1' });
    expect(res.status).toBe(400);
  });

  it('signed-up user shows in the admin users list as a regular user', async () => {
    const res = await adminAgent.get('/api/v1/users');
    expect(res.status).toBe(200);
    const row = res.body.find((u: { username: string }) => u.username === 'newplayer');
    expect(row).toBeDefined();
    expect(row.serverRole).toBe('user');
    expect(row.disabled).toBe(false);
  });

  it('allowSignup=true but allowLocalLogin=false -> signupEnabled=false and signup 403', async () => {
    const server = ctx.app.getHttpServer();

    const patchRes = await adminAgent.patch('/api/v1/settings').send({ allowLocalLogin: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.allowSignup).toBe(true);
    expect(patchRes.body.allowLocalLogin).toBe(false);

    const status = await request(server).get('/api/v1/auth/status');
    expect(status.body.signupEnabled).toBe(false);

    const res = await request(server)
      .post('/api/v1/auth/signup')
      .send({ username: 'lockedout', password: 'lockedout-password-1' });
    expect(res.status).toBe(403);

    // Restore for any later assertions.
    await adminAgent.patch('/api/v1/settings').send({ allowLocalLogin: true });
  });

  it('turning allowSignup back off blocks further signups (403)', async () => {
    const server = ctx.app.getHttpServer();

    const patchRes = await adminAgent.patch('/api/v1/settings').send({ allowSignup: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.allowSignup).toBe(false);

    const status = await request(server).get('/api/v1/auth/status');
    expect(status.body.signupEnabled).toBe(false);

    const res = await request(server)
      .post('/api/v1/auth/signup')
      .send({ username: 'toolate', password: 'toolate-password-1' });
    expect(res.status).toBe(403);

    // Accounts created while it was on keep working.
    const relogin = await request(server).post('/api/v1/auth/login').send({ username: 'newplayer', password: 'player-password-1' });
    expect(relogin.status).toBe(201);
  });
});
