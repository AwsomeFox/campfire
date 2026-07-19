import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * P1 fix pinning tests — see user.types.ts (hasServerAdminPower), server-roles.guard.ts,
 * tokens.service.ts (create/mintFor), mcp-tools.ts (install_rule_pack).
 *
 * VERIFIED finding this closes: a PAT's `scope` (dm/player/viewer) previously capped
 * only the per-campaign role via RoleResolver — it did NOT constrain the token
 * owner's `serverRole`. A viewer-scoped token minted for a server admin therefore
 * still passed ServerRolesGuard (POST /users, /settings) and the MCP
 * install_rule_pack tool's `user.serverRole !== 'admin'` check: the
 * "least-privilege" token an operator hands an AI was actually root.
 *
 * Fix: a token's effective SERVER-admin power now requires BOTH the owner's
 * serverRole==='admin' AND (no tokenContext (cookie session) OR
 * tokenContext.adminEnabled===true). adminEnabled defaults false and can only be
 * set true by a caller who is CURRENTLY exercising real (non-token-capped)
 * server-admin power.
 */
describe('P1: a token only carries SERVER-admin power when explicitly adminEnabled (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'cap-admin', password: 'admin-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('self-service POST /tokens (the exact adversarial repro)', () => {
    it('a viewer-scoped token minted by an admin does NOT default to adminEnabled, and is rejected by every server-admin gate', async () => {
      const server = ctx.app.getHttpServer();

      const mintRes = await adminAgent.post('/api/v1/tokens').send({ name: 'viewer-scoped-admin-owned', scope: 'viewer' });
      expect(mintRes.status).toBe(201);
      expect(mintRes.body.apiToken.adminEnabled).toBe(false);
      const rawToken = mintRes.body.token;

      // Exact repro: POST /users (create an admin) -> must now 403, not 201.
      const createUserRes = await request(server)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ username: 'should-not-be-created', password: 'irrelevant-password-1', serverRole: 'admin' });
      expect(createUserRes.status).toBe(403);

      // Exact repro: PATCH /settings -> must now 403, not 200.
      const settingsRes = await request(server)
        .patch('/api/v1/settings')
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ allowLocalLogin: false });
      expect(settingsRes.status).toBe(403);

      // Exact repro: minting arbitrary tokens via the admin-provisioning route -> must now 403.
      const mintForOtherRes = await request(server)
        .post('/api/v1/users/1/tokens')
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ tokenName: 'sneaky' });
      expect(mintForOtherRes.status).toBe(403);
    });

    it('a dm-scoped (not just viewer) token minted by an admin is equally non-admin by default', async () => {
      const server = ctx.app.getHttpServer();
      const mintRes = await adminAgent.post('/api/v1/tokens').send({ name: 'dm-scoped-admin-owned', scope: 'dm' });
      expect(mintRes.status).toBe(201);
      expect(mintRes.body.apiToken.adminEnabled).toBe(false);

      const settingsRes = await request(server).get('/api/v1/settings').set('Authorization', `Bearer ${mintRes.body.token}`);
      expect(settingsRes.status).toBe(403);
    });

    it('requesting adminEnabled:true is silently downgraded to false when the caller is not currently a server admin', async () => {
      const server = ctx.app.getHttpServer();
      await adminAgent.post('/api/v1/users').send({ username: 'cap-nonadmin', password: 'nonadmin-password-1', serverRole: 'user' });
      const nonAdminAgent = request.agent(server);
      await nonAdminAgent.post('/api/v1/auth/login').send({ username: 'cap-nonadmin', password: 'nonadmin-password-1' });

      const mintRes = await nonAdminAgent.post('/api/v1/tokens').send({ name: 'nonadmin-tries-admin', scope: 'viewer', adminEnabled: true });
      expect(mintRes.status).toBe(201); // request succeeds, but...
      expect(mintRes.body.apiToken.adminEnabled).toBe(false); // ...silently downgraded, not honored.
    });

    it('an explicitly adminEnabled:true token, minted by a currently-real admin, DOES pass server-admin gates', async () => {
      const server = ctx.app.getHttpServer();

      const mintRes = await adminAgent.post('/api/v1/tokens').send({ name: 'admin-enabled-token', scope: 'viewer', adminEnabled: true });
      expect(mintRes.status).toBe(201);
      expect(mintRes.body.apiToken.adminEnabled).toBe(true);
      const rawToken = mintRes.body.token;

      const settingsRes = await request(server).get('/api/v1/settings').set('Authorization', `Bearer ${rawToken}`);
      expect(settingsRes.status).toBe(200);

      const usersRes = await request(server).get('/api/v1/users').set('Authorization', `Bearer ${rawToken}`);
      expect(usersRes.status).toBe(200);
    });

    it('an admin-enabled token cannot mint a FURTHER admin-enabled token if minted through a non-admin-enabled token first (no privilege laundering)', async () => {
      // Sanity: an ordinary (non-admin-enabled) admin-owned token cannot bootstrap its way
      // to adminEnabled:true by minting a "child" token — hasServerAdminPower() is checked
      // against the CALLING token's own tokenContext, not just the owning user's serverRole.
      const server = ctx.app.getHttpServer();
      const plainMint = await adminAgent.post('/api/v1/tokens').send({ name: 'plain-for-laundering-test', scope: 'dm' });
      const plainToken = plainMint.body.token;

      const launderRes = await request(server)
        .post('/api/v1/tokens')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ name: 'laundered-admin-token', scope: 'dm', adminEnabled: true });
      expect(launderRes.status).toBe(201);
      expect(launderRes.body.apiToken.adminEnabled).toBe(false);
    });
  });

  describe('cookie session (no tokenContext) is unaffected', () => {
    it('the admin cookie session itself still passes every server-admin gate untouched', async () => {
      const settingsRes = await adminAgent.get('/api/v1/settings');
      expect(settingsRes.status).toBe(200);
      const usersRes = await adminAgent.get('/api/v1/users');
      expect(usersRes.status).toBe(200);
    });
  });

  describe('POST /auth/token headless bootstrap', () => {
    it('adminEnabled:true is honored when the authenticating user is themselves a real admin', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ username: 'cap-admin', password: 'admin-password-1', tokenName: 'headless-admin-token', scope: 'viewer', adminEnabled: true });
      expect(res.status).toBe(201);
      expect(res.body.apiToken.adminEnabled).toBe(true);
    });

    it('adminEnabled:true is silently downgraded for a non-admin user', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ username: 'cap-nonadmin', password: 'nonadmin-password-1', tokenName: 'headless-nonadmin-token', scope: 'viewer', adminEnabled: true });
      expect(res.status).toBe(201);
      expect(res.body.apiToken.adminEnabled).toBe(false);
    });
  });

  describe('POST /users/:id/tokens admin provisioning', () => {
    it('adminEnabled:true is honored only when BOTH the calling admin currently holds real admin power AND the target is themselves an admin', async () => {
      const server = ctx.app.getHttpServer();

      // Target: another admin user.
      const createAdminRes = await adminAgent.post('/api/v1/users').send({ username: 'cap-second-admin', password: 'second-admin-pw-1', serverRole: 'admin' });
      const secondAdminId = createAdminRes.body.id;

      const mintRes = await adminAgent
        .post(`/api/v1/users/${secondAdminId}/tokens`)
        .send({ tokenName: 'provisioned-admin-token', scope: 'viewer', adminEnabled: true });
      expect(mintRes.status).toBe(201);
      expect(mintRes.body.apiToken.adminEnabled).toBe(true);

      const settingsRes = await request(server).get('/api/v1/settings').set('Authorization', `Bearer ${mintRes.body.token}`);
      expect(settingsRes.status).toBe(200);
    });

    it('adminEnabled:true is silently downgraded when the TARGET user is not an admin, even though the calling admin is real', async () => {
      const createUserRes = await adminAgent.post('/api/v1/users').send({ username: 'cap-target-nonadmin', password: 'target-pw-1', serverRole: 'user' });
      const targetId = createUserRes.body.id;

      const mintRes = await adminAgent
        .post(`/api/v1/users/${targetId}/tokens`)
        .send({ tokenName: 'provisioned-for-nonadmin', scope: 'viewer', adminEnabled: true });
      expect(mintRes.status).toBe(201);
      expect(mintRes.body.apiToken.adminEnabled).toBe(false);
    });

    it('a non-admin-enabled token cannot even reach POST /users/:id/tokens (blocked at ServerRolesGuard, same as any other server-admin route)', async () => {
      const server = ctx.app.getHttpServer();
      const plainMint = await adminAgent.post('/api/v1/tokens').send({ name: 'plain-admin-token-for-provisioning', scope: 'dm' });
      const plainToken = plainMint.body.token;

      const createAdminRes = await adminAgent.post('/api/v1/users').send({ username: 'cap-third-admin', password: 'third-admin-pw-1', serverRole: 'admin' });
      const thirdAdminId = createAdminRes.body.id;

      const mintRes = await request(server)
        .post(`/api/v1/users/${thirdAdminId}/tokens`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tokenName: 'laundered-provisioned-token', adminEnabled: true });
      expect(mintRes.status).toBe(403);
    });
  });

  describe('MCP install_rule_pack — the other server-admin gate outside REST', () => {
    const clients: Client[] = [];

    async function mcpClient(token: string): Promise<Client> {
      const client = new Client({ name: 'campfire-e2e-admin-cap', version: '0.0.1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    }

    afterAll(async () => {
      for (const client of clients) {
        await client.close().catch(() => undefined);
      }
    });

    it('a viewer-scoped token owned by a server admin is denied install_rule_pack (403/isError, not the old serverRole passthrough)', async () => {
      const mintRes = await adminAgent.post('/api/v1/tokens').send({ name: 'mcp-viewer-admin-owned', scope: 'viewer' });
      expect(mintRes.body.apiToken.adminEnabled).toBe(false);

      const client = await mcpClient(mintRes.body.token);
      const result = await client.callTool({ name: 'install_rule_pack', arguments: { source: 'open5e' } });
      expect(result.isError).toBe(true);
    });

    it('an adminEnabled:true token owned by a server admin IS allowed to call install_rule_pack (reaches the real service, not blocked by the gate)', async () => {
      const mintRes = await adminAgent.post('/api/v1/tokens').send({ name: 'mcp-admin-enabled', scope: 'viewer', adminEnabled: true });
      expect(mintRes.body.apiToken.adminEnabled).toBe(true);

      const client = await mcpClient(mintRes.body.token);
      const result = await client.callTool({ name: 'install_rule_pack', arguments: { source: 'open5e', url: 'http://127.0.0.1:1/nonexistent' } });
      // Not the ForbiddenException('Requires server admin') path — it gets past the gate and
      // fails downstream instead (unreachable fake URL), proving the gate itself let it through.
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).not.toContain('Requires server admin');
    });
  });
});
