import request from 'supertest';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { users } from '../src/db/schema';
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

  it('oversized password (>200 chars) is rejected 400 by zod, before scrypt ever runs', async () => {
    // Regression test for punch list item 5: LoginRequest.password previously had no .max(),
    // so an unauthenticated caller could force the server to run scrypt (CPU-heavy) against
    // an arbitrarily large password before verifyPassword() got a chance to reject it.
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'x'.repeat(300) });
    expect(res.status).toBe(400);
  });

  it('password at the 200-char boundary is still a normal (wrong-password) 401, not a 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'y'.repeat(200) });
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

/**
 * Issue #89: account existence / type enumeration hardening. Every credential
 * failure that must NOT reveal whether a username exists — unknown user, wrong
 * password, and SSO-only account (no local password) — has to return the exact
 * same status AND the exact same response body, and must cost the same scrypt
 * work so timing can't be used as an existence/type oracle either.
 */
describe('login enumeration hardening (e2e) — uniform failure for unknown/wrong/SSO', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'realuser', password: 'real-password-1' });

    // Create an account and null out its local hash to simulate an SSO-provisioned
    // (OIDC) user — the state that previously returned a distinctive 403 "This
    // account uses SSO" before any password check even ran.
    const created = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'ssouser', password: 'placeholder-password-1', serverRole: 'user' });
    expect(created.status).toBe(201);
    const db = ctx.app.get<DrizzleDb>(DB);
    await db.update(users).set({ passwordHash: null }).where(eq(users.username, 'ssouser'));
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('unknown user, wrong password, and SSO-only account return an IDENTICAL status + body', async () => {
    const server = ctx.app.getHttpServer();

    const unknown = await request(server).post('/api/v1/auth/login').send({ username: 'no-such-user', password: 'whatever-12' });
    const wrong = await request(server).post('/api/v1/auth/login').send({ username: 'realuser', password: 'wrong-password-1' });
    const sso = await request(server).post('/api/v1/auth/login').send({ username: 'ssouser', password: 'placeholder-password-1' });

    // Same status...
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(sso.status).toBe(401);

    // ...and byte-for-byte the same body (no message/error that distinguishes the case).
    expect(wrong.body).toEqual(unknown.body);
    expect(sso.body).toEqual(unknown.body);
    expect(unknown.body.message).toBe('Invalid username or password');
    // The old SSO-specific signal must be gone.
    expect(JSON.stringify(sso.body)).not.toMatch(/SSO/i);
  });

  it('same uniform 401 on the headless PAT bootstrap path (POST /auth/token) for unknown vs SSO-only', async () => {
    const server = ctx.app.getHttpServer();
    const unknown = await request(server).post('/api/v1/auth/token').send({ username: 'no-such-user', password: 'whatever-12', tokenName: 'x' });
    const sso = await request(server).post('/api/v1/auth/token').send({ username: 'ssouser', password: 'placeholder-password-1', tokenName: 'x' });
    expect(unknown.status).toBe(401);
    expect(sso.status).toBe(401);
    expect(sso.body).toEqual(unknown.body);
  });

  it('timing: the unknown-user path still spends scrypt work (not skipped), so it is not an obvious timing oracle', async () => {
    const server = ctx.app.getHttpServer();
    const SAMPLES = 6;

    async function bestOf(username: string, password: string): Promise<number> {
      let best = Infinity;
      for (let i = 0; i < SAMPLES; i++) {
        const start = process.hrtime.bigint();
        await request(server).post('/api/v1/auth/login').send({ username, password });
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        if (ms < best) best = ms;
      }
      return best;
    }

    // Best-case (minimum) times are the most stable and the ones that matter for a
    // timing attack. A real wrong-password attempt runs one scrypt (~30ms); if the
    // unknown-user path skipped scrypt it would return an order of magnitude faster.
    // We only require it to stay within a generous factor — enough to prove scrypt
    // runs for absent users without being flaky under CI load.
    const wrongBest = await bestOf('realuser', 'wrong-password-1');
    const unknownBest = await bestOf('no-such-user', 'whatever-12');
    expect(unknownBest).toBeGreaterThan(wrongBest * 0.4);
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

describe('me/preferences (e2e)', () => {
  let ctx: TestAppContext;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    agent = request.agent(ctx.app.getHttpServer());
    await agent.post('/api/v1/auth/setup').send({ username: 'prefsuser', password: 'original-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('accentColor defaults to null on /me', async () => {
    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.accentColor).toBeNull();
  });

  it('setting a valid accent color -> /me reflects it', async () => {
    const patchRes = await agent.patch('/api/v1/me/preferences').send({ accentColor: '#e0a458' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.accentColor).toBe('#e0a458');

    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.accentColor).toBe('#e0a458');
  });

  it('invalid hex -> 400', async () => {
    const res = await agent.patch('/api/v1/me/preferences').send({ accentColor: 'not-a-color' });
    expect(res.status).toBe(400);
  });

  it('invalid hex (missing #) -> 400', async () => {
    const res = await agent.patch('/api/v1/me/preferences').send({ accentColor: 'e0a458e0' });
    expect(res.status).toBe(400);
  });

  it('displayName change is reflected on /me', async () => {
    const patchRes = await agent.patch('/api/v1/me/preferences').send({ displayName: 'Prefs User' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.displayName).toBe('Prefs User');

    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.displayName).toBe('Prefs User');
    // Previously-set accent color is untouched by an unrelated displayName-only update.
    expect(meRes.body.user.accentColor).toBe('#e0a458');
  });

  it('setting accentColor back to null clears the override', async () => {
    const patchRes = await agent.patch('/api/v1/me/preferences').send({ accentColor: null });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.accentColor).toBeNull();
  });

  it('textSize defaults to default on /me', async () => {
    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.textSize).toBe('default');
  });

  it('setting textSize large -> /me reflects it', async () => {
    const patchRes = await agent.patch('/api/v1/me/preferences').send({ textSize: 'large' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.textSize).toBe('large');

    const meRes = await agent.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.textSize).toBe('large');
    // Previously-set displayName is untouched by an unrelated textSize-only update.
    expect(meRes.body.user.displayName).toBe('Prefs User');
  });

  it('invalid textSize -> 400', async () => {
    const res = await agent.patch('/api/v1/me/preferences').send({ textSize: 'enormous' });
    expect(res.status).toBe(400);
  });

  it('setting textSize back to default clears the override', async () => {
    const patchRes = await agent.patch('/api/v1/me/preferences').send({ textSize: 'default' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.textSize).toBe('default');
  });

  it('unauthenticated PATCH /me/preferences -> 401', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).patch('/api/v1/me/preferences').send({ displayName: 'Nope' });
    expect(res.status).toBe(401);
  });
});

/**
 * P0: headless PAT bootstrap (POST /auth/token, @Public) — verifies credentials
 * via the exact same path as POST /auth/login (AuthService.verifyCredentials(),
 * shared by both) and mints a PAT in the SAME call, no cookie/session needed.
 * See AuthController.token() / TokensService.mintFor().
 */
describe('POST /auth/token — headless PAT bootstrap (e2e)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let otherCampaignId: number;
  const mcpClients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    mcpClients.push(client);
    return client;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    dmAgent = request.agent(ctx.app.getHttpServer());
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'bootstrap-dm', password: 'dm-password-1' });

    await dmAgent.post('/api/v1/users').send({ username: 'bootstrap-player', password: 'player-password-1', serverRole: 'user' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Bootstrap Campaign' });
    campaignId = campRes.body.id;
    const otherCampRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Other Bootstrap Campaign' });
    otherCampaignId = otherCampRes.body.id;
  });

  afterAll(async () => {
    for (const client of mcpClients) {
      await client.close().catch(() => undefined);
    }
    await closeTestApp(ctx);
  });

  it('valid creds -> one call returns a working PAT, no cookie set', async () => {
    // writeScope: 'direct' is explicit — the safe default is 'propose' now
    // (issue #575), but this test asserts a DIRECT canon write (201 quest
    // create), so we opt in rather than rely on the default.
    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-dm', password: 'dm-password-1', tokenName: 'agent-bootstrap', scope: 'dm', writeScope: 'direct' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^cf_pat_[0-9a-f]{48}$/);
    expect(res.body.apiToken.scope).toBe('dm');
    expect(res.headers['set-cookie']).toBeUndefined();

    const rawToken = res.body.token;

    // Works as Bearer on a REST route.
    const meRes = await request(baseUrl).get('/api/v1/me').set('Authorization', `Bearer ${rawToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe('bootstrap-dm');

    // Works as Bearer on a campaign write.
    const questRes = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ title: 'Bootstrapped quest' });
    expect(questRes.status).toBe(201);

    // Works as Bearer on MCP.
    const client = await mcpClient(rawToken);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('scope defaults to viewer when omitted', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-dm', password: 'dm-password-1', tokenName: 'agent-default-scope' });
    expect(res.status).toBe(201);
    expect(res.body.apiToken.scope).toBe('viewer');
  });

  it('bad password -> 401, no token minted', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-dm', password: 'wrong-password', tokenName: 'should-not-exist' });
    expect(res.status).toBe(401);

    const listRes = await dmAgent.get('/api/v1/tokens');
    expect(listRes.body.some((t: { name: string }) => t.name === 'should-not-exist')).toBe(false);
  });

  it('unknown username -> 401 (generic, no user-enumeration signal)', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'no-such-user', password: 'whatever12', tokenName: 'nope' });
    expect(res.status).toBe(401);
  });

  it('disabled account -> 403', async () => {
    const createRes = await dmAgent.post('/api/v1/users').send({ username: 'bootstrap-disabled', password: 'disabled-password-1' });
    await dmAgent.patch(`/api/v1/users/${createRes.body.id}`).send({ disabled: true });

    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-disabled', password: 'disabled-password-1', tokenName: 'nope' });
    expect(res.status).toBe(403);
  });

  it('scoped to a campaign the user cannot access -> 403, no token minted', async () => {
    // bootstrap-player is not a member of otherCampaignId (only campaignId, added below).
    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-player', password: 'player-password-1', tokenName: 'sneaky', scope: 'viewer', campaignId: otherCampaignId });
    expect(res.status).toBe(403);
  });

  it('scoped to a campaign the user DOES have access to succeeds and caps the token', async () => {
    const memberLookup = await dmAgent.get('/api/v1/users/lookup').query({ query: 'bootstrap-player' });
    const playerId = memberLookup.body[0].id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-player', password: 'player-password-1', tokenName: 'player-scoped', scope: 'player', campaignId });
    expect(res.status).toBe(201);
    expect(res.body.apiToken.campaignId).toBe(campaignId);

    const rawToken = res.body.token;
    const otherRes = await request(baseUrl).get(`/api/v1/campaigns/${otherCampaignId}`).set('Authorization', `Bearer ${rawToken}`);
    expect(otherRes.status).toBe(403);
  });

  // Issue #88: /users/lookup is gated to a dm-of-any-campaign (or server admin). A
  // token scoped BELOW dm can never act as a dm (RoleResolver caps effective role),
  // so it must not be able to enumerate the user directory — even when minted for a
  // user who really is a dm. A dm-scoped token keeps the add-member flow working.
  it('a viewer-scoped PAT (even for a real dm) cannot enumerate the user directory (403)', async () => {
    const mint = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-dm', password: 'dm-password-1', tokenName: 'viewer-lookup', scope: 'viewer' });
    expect(mint.status).toBe(201);

    const res = await request(baseUrl)
      .get('/api/v1/users/lookup')
      .query({ query: 'bootstrap' })
      .set('Authorization', `Bearer ${mint.body.token}`);
    expect(res.status).toBe(403);
  });

  it('a dm-scoped PAT can use the lookup (add-member flow over a headless agent)', async () => {
    const mint = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-dm', password: 'dm-password-1', tokenName: 'dm-lookup', scope: 'dm' });
    expect(mint.status).toBe(201);

    const res = await request(baseUrl)
      .get('/api/v1/users/lookup')
      .query({ query: 'bootstrap-player' })
      .set('Authorization', `Bearer ${mint.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((u: { username: string }) => u.username === 'bootstrap-player')).toBe(true);
  });

  it('oversized password (>200 chars) is rejected 400, before scrypt runs', async () => {
    const res = await request(baseUrl)
      .post('/api/v1/auth/token')
      .send({ username: 'bootstrap-dm', password: 'x'.repeat(300), tokenName: 'nope' });
    expect(res.status).toBe(400);
  });
});

/**
 * Issue #128 (player data rights): an authenticated user may delete THEIR OWN
 * account via DELETE /me. It reuses UsersService.remove(), so the same cleanup +
 * guards apply: sessions/tokens/memberships cascade, owned characters are
 * de-linked (kept, ownerUserId cleared), last-admin/sole-dm deletions are refused.
 */
describe('self-delete account (e2e, issue #128)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'sd-admin', password: 'admin-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a player deletes their own account (204); owned character is de-linked but kept; account gone', async () => {
    const server = ctx.app.getHttpServer();

    // A DM with a campaign, and a player who owns a linked character.
    const createDm = await adminAgent.post('/api/v1/users').send({ username: 'sd-dm', password: 'dm-password-1', serverRole: 'user' });
    const dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'sd-dm', password: 'dm-password-1' });
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Self Delete Campaign' });
    const campaignId = campRes.body.id;

    const createPlayer = await adminAgent.post('/api/v1/users').send({ username: 'sd-player', password: 'player-password-1', serverRole: 'user' });
    const playerId = createPlayer.body.id;
    const playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'sd-player', password: 'player-password-1' });

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Owned By Player' });
    const charId = charRes.body.id;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player', characterId: charId });

    // Player self-deletes.
    const delRes = await playerAgent.delete('/api/v1/me');
    expect(delRes.status).toBe(204);

    // Account is gone (login fails, and the admin roster no longer lists them).
    const relogin = await request(server).post('/api/v1/auth/login').send({ username: 'sd-player', password: 'player-password-1' });
    expect(relogin.status).toBe(401);
    const roster = await adminAgent.get('/api/v1/users');
    expect(roster.body.some((u: { id: number }) => u.id === playerId)).toBe(false);

    // Character SHEET survives, de-linked (ownerUserId cleared).
    const charAfter = await dmAgent.get(`/api/v1/characters/${charId}`);
    expect(charAfter.status).toBe(200);
    expect(charAfter.body.ownerUserId).toBeNull();

    // The now-stale session cookie no longer authenticates.
    expect((await playerAgent.get('/api/v1/me')).status).toBe(401);
  });

  it('the last enabled admin cannot self-delete (409)', async () => {
    const res = await adminAgent.delete('/api/v1/me');
    expect(res.status).toBe(409);
    // Still there and usable.
    expect((await adminAgent.get('/api/v1/me')).status).toBe(200);
  });

  it('the sole dm of a campaign cannot self-delete until dm is handed off (409 -> 204)', async () => {
    const server = ctx.app.getHttpServer();
    const createSoleDm = await adminAgent.post('/api/v1/users').send({ username: 'sd-soledm', password: 'soledm-password-1', serverRole: 'user' });
    const soleDmId = createSoleDm.body.id;
    const soleDm = request.agent(server);
    await soleDm.post('/api/v1/auth/login').send({ username: 'sd-soledm', password: 'soledm-password-1' });
    const campRes = await soleDm.post('/api/v1/campaigns').send({ name: 'Sole DM Self Delete' });
    const campaignId = campRes.body.id;

    // Blocked while sole dm.
    expect((await soleDm.delete('/api/v1/me')).status).toBe(409);

    // Promote a co-dm, then self-delete succeeds.
    const createCoDm = await adminAgent.post('/api/v1/users').send({ username: 'sd-codm', password: 'codm-password-1', serverRole: 'user' });
    await soleDm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: createCoDm.body.id, role: 'dm' });
    expect((await soleDm.delete('/api/v1/me')).status).toBe(204);
    const roster = await adminAgent.get('/api/v1/users');
    expect(roster.body.some((u: { id: number }) => u.id === soleDmId)).toBe(false);
  });
});
