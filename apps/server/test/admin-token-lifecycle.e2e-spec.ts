import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #44: PAT lifecycle from the admin side.
 *  - GET    /users/:id/tokens          — admin lists another user's PATs (metadata only)
 *  - DELETE /users/:id/tokens/:tokenId — admin revokes one PAT
 *  - DELETE /users/:id/tokens          — admin revokes ALL of a user's PATs
 *  - POST   /users/:id/password        — admin reset now revokes ALL sessions AND PATs
 * Plus a pin on the deliberate asymmetry: self-service POST /me/password keeps
 * the current session and leaves PATs alone (the user proves the old password
 * and manages their own tokens via /tokens).
 */
describe('admin PAT lifecycle: list/revoke + password-reset revocation (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let adminId: number;
  let playerId: number;

  const mintOwn = async (agent: ReturnType<typeof request.agent>, name: string) => {
    const res = await agent.post('/api/v1/tokens').send({ name, scope: 'viewer' });
    expect(res.status).toBe(201);
    return { raw: res.body.token as string, id: res.body.apiToken.id as number };
  };

  const bearerMe = (raw: string) => request(ctx.app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${raw}`);

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    const setupRes = await adminAgent.post('/api/v1/auth/setup').send({ username: 'lifecycle-admin', password: 'admin-password-1' });
    adminId = setupRes.body.user.id;

    const createRes = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'lifecycle-player', password: 'player-password-1', serverRole: 'user' });
    playerId = createRes.body.id;

    playerAgent = request.agent(server);
    await playerAgent.post('/api/v1/auth/login').send({ username: 'lifecycle-player', password: 'player-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('GET /users/:id/tokens', () => {
    it("admin lists another user's tokens: metadata only, never raw values", async () => {
      await mintOwn(playerAgent, 'list-me-a');
      await mintOwn(playerAgent, 'list-me-b');

      const res = await adminAgent.get(`/api/v1/users/${playerId}/tokens`);
      expect(res.status).toBe(200);
      const names = res.body.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(['list-me-a', 'list-me-b']));
      for (const t of res.body) {
        expect(t.userId).toBe(playerId);
        expect(t.tokenPrefix).toMatch(/^cf_pat_/);
        // Raw token / hash must never appear in the admin listing.
        expect(t.token).toBeUndefined();
        expect(t.tokenHash).toBeUndefined();
      }
    });

    it('non-admin cannot list another user\'s tokens -> 403', async () => {
      const res = await playerAgent.get(`/api/v1/users/${adminId}/tokens`);
      expect(res.status).toBe(403);
    });

    it('unknown user -> 404', async () => {
      const res = await adminAgent.get('/api/v1/users/999999/tokens');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /users/:id/tokens/:tokenId', () => {
    it("admin revokes one of the user's tokens; it stops working, siblings survive", async () => {
      const doomed = await mintOwn(playerAgent, 'doomed');
      const survivor = await mintOwn(playerAgent, 'survivor');

      expect((await bearerMe(doomed.raw)).status).toBe(200);

      const delRes = await adminAgent.delete(`/api/v1/users/${playerId}/tokens/${doomed.id}`);
      expect(delRes.status).toBe(204);

      expect((await bearerMe(doomed.raw)).status).toBe(401);
      expect((await bearerMe(survivor.raw)).status).toBe(200);
    });

    it('tokenId owned by a DIFFERENT user than :id -> 404 (no cross-user revoke by mismatched path)', async () => {
      const adminOwned = await mintOwn(adminAgent, 'admin-owned');

      // Path says player, token belongs to admin: ownership-scoped remove() 404s.
      const res = await adminAgent.delete(`/api/v1/users/${playerId}/tokens/${adminOwned.id}`);
      expect(res.status).toBe(404);
      expect((await bearerMe(adminOwned.raw)).status).toBe(200);
    });

    it('non-admin cannot revoke via the admin route -> 403', async () => {
      const mine = await mintOwn(playerAgent, 'player-owned');
      const res = await playerAgent.delete(`/api/v1/users/${playerId}/tokens/${mine.id}`);
      expect(res.status).toBe(403);
      expect((await bearerMe(mine.raw)).status).toBe(200);
    });
  });

  describe('DELETE /users/:id/tokens (revoke all)', () => {
    it("admin revokes every token the user has; all stop working; idempotent on repeat", async () => {
      const a = await mintOwn(playerAgent, 'nuke-a');
      const b = await mintOwn(playerAgent, 'nuke-b');

      const res = await adminAgent.delete(`/api/v1/users/${playerId}/tokens`);
      expect(res.status).toBe(204);

      expect((await bearerMe(a.raw)).status).toBe(401);
      expect((await bearerMe(b.raw)).status).toBe(401);

      const listRes = await adminAgent.get(`/api/v1/users/${playerId}/tokens`);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toEqual([]);

      // Idempotent: nothing left to revoke is still a 204, not an error.
      const again = await adminAgent.delete(`/api/v1/users/${playerId}/tokens`);
      expect(again.status).toBe(204);
    });

    it('unknown user -> 404', async () => {
      const res = await adminAgent.delete('/api/v1/users/999999/tokens');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /users/:id/password — admin reset revokes sessions AND PATs', () => {
    it('after an admin reset, the user\'s PAT and existing session are dead; only the new password works', async () => {
      const server = ctx.app.getHttpServer();

      await adminAgent.post('/api/v1/users').send({ username: 'reset-victim', password: 'victim-password-1', serverRole: 'user' });
      const victimAgent = request.agent(server);
      const loginRes = await victimAgent.post('/api/v1/auth/login').send({ username: 'reset-victim', password: 'victim-password-1' });
      expect(loginRes.status).toBe(201);
      const victimId = loginRes.body.user.id;

      const pat = await mintOwn(victimAgent, 'leaked-laptop-token');
      expect((await bearerMe(pat.raw)).status).toBe(200);
      expect((await victimAgent.get('/api/v1/me')).status).toBe(200);

      const resetRes = await adminAgent.post(`/api/v1/users/${victimId}/password`).send({ newPassword: 'rotated-password-9' });
      expect(resetRes.status).toBe(204);

      // The leaked PAT no longer authenticates.
      expect((await bearerMe(pat.raw)).status).toBe(401);
      // The pre-reset cookie session is revoked too.
      expect((await victimAgent.get('/api/v1/me')).status).toBe(401);
      // Old password is gone, new one works.
      const oldLogin = await request(server).post('/api/v1/auth/login').send({ username: 'reset-victim', password: 'victim-password-1' });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(server).post('/api/v1/auth/login').send({ username: 'reset-victim', password: 'rotated-password-9' });
      expect(newLogin.status).toBe(201);
    });
  });

  describe('POST /me/password — self-service change deliberately keeps PATs + current session', () => {
    it('changing your own password (with currentPassword) does not revoke your PATs or the session you used', async () => {
      const server = ctx.app.getHttpServer();

      await adminAgent.post('/api/v1/users').send({ username: 'self-changer', password: 'self-password-1', serverRole: 'user' });
      const selfAgent = request.agent(server);
      await selfAgent.post('/api/v1/auth/login').send({ username: 'self-changer', password: 'self-password-1' });

      const pat = await mintOwn(selfAgent, 'keep-me');

      const changeRes = await selfAgent
        .post('/api/v1/me/password')
        .send({ currentPassword: 'self-password-1', newPassword: 'self-password-2' });
      expect(changeRes.status).toBe(204);

      // Current session survives (only OTHER sessions are killed) and the PAT survives.
      expect((await selfAgent.get('/api/v1/me')).status).toBe(200);
      expect((await bearerMe(pat.raw)).status).toBe(200);
    });
  });
});
