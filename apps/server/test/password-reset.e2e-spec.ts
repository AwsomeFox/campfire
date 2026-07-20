import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Forgot-password / self-service reset (issue #10) — admin-approved flow, no
 * mail transport required. See modules/auth/password-reset.service.ts.
 *
 *   POST /auth/reset-request   @Public — always 202, no user-enumeration signal
 *   GET  /users/reset-requests admin — list open requests
 *   POST /users/reset-requests/:id/approve admin — mints one-time code (returned once)
 *   DELETE /users/reset-requests/:id admin — dismiss/revoke
 *   POST /auth/reset-confirm   @Public — redeems code, sets password, kills sessions
 */
describe('password reset — request/approve/confirm (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'forgetful', password: 'old-password-1', serverRole: 'user' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('unknown username -> 202 with the SAME body as a real one (no enumeration signal), and no row appears', async () => {
    const server = ctx.app.getHttpServer();

    const unknownRes = await request(server).post('/api/v1/auth/reset-request').send({ username: 'no-such-user' });
    expect(unknownRes.status).toBe(202);

    const knownRes = await request(server).post('/api/v1/auth/reset-request').send({ username: 'forgetful' });
    expect(knownRes.status).toBe(202);
    expect(knownRes.body).toEqual(unknownRes.body);

    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].username).toBe('forgetful');
    expect(listRes.body[0].status).toBe('pending');
    // The hash never leaves the server, and nothing code-like is exposed pre-approval.
    expect(listRes.body[0].codeHash).toBeUndefined();
  });

  it('re-requesting is idempotent — still exactly one open row', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/auth/reset-request').send({ username: 'forgetful' });
    expect(res.status).toBe(202);

    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listRes.body).toHaveLength(1);
  });

  it('admin endpoints are admin-only (403 for a regular user, 401 unauthenticated)', async () => {
    const server = ctx.app.getHttpServer();

    const unauthRes = await request(server).get('/api/v1/users/reset-requests');
    expect(unauthRes.status).toBe(401);

    const userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'forgetful', password: 'old-password-1' });
    const forbiddenList = await userAgent.get('/api/v1/users/reset-requests');
    expect(forbiddenList.status).toBe(403);
    const forbiddenApprove = await userAgent.post('/api/v1/users/reset-requests/1/approve');
    expect(forbiddenApprove.status).toBe(403);
  });

  it('full happy path: approve -> code redeems once -> sessions killed -> new password works', async () => {
    const server = ctx.app.getHttpServer();

    // The user has a live session (from the previous test's login) that must die on reset.
    const oldSessionAgent = request.agent(server);
    await oldSessionAgent.post('/api/v1/auth/login').send({ username: 'forgetful', password: 'old-password-1' });
    expect((await oldSessionAgent.get('/api/v1/me')).status).toBe(200);

    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    const requestId = listRes.body[0].id;

    const approveRes = await adminAgent.post(`/api/v1/users/reset-requests/${requestId}/approve`);
    expect(approveRes.status).toBe(201);
    expect(approveRes.body.code).toMatch(/^cf_reset_[0-9a-f]{32}$/);
    expect(approveRes.body.expiresAt).toBeDefined();
    expect(approveRes.body.request.status).toBe('approved');
    const code = approveRes.body.code;

    // Approved (not completed) shows in the list, still without any secret material.
    const listAfterApprove = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listAfterApprove.body[0].status).toBe('approved');
    expect(listAfterApprove.body[0].expiresAt).toBeDefined();
    expect(JSON.stringify(listAfterApprove.body)).not.toContain(code);

    // Redeem.
    const confirmRes = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code, newPassword: 'brand-new-password-1' });
    expect(confirmRes.status).toBe(204);

    // Request row is gone; old sessions are dead.
    const listAfterConfirm = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listAfterConfirm.body).toHaveLength(0);
    expect((await oldSessionAgent.get('/api/v1/me')).status).toBe(401);

    // Old password no longer works; new one does.
    const oldLogin = await request(server).post('/api/v1/auth/login').send({ username: 'forgetful', password: 'old-password-1' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(server).post('/api/v1/auth/login').send({ username: 'forgetful', password: 'brand-new-password-1' });
    expect(newLogin.status).toBe(201);

    // Single-use: the same code is dead now (generic 400).
    const reuseRes = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code, newPassword: 'yet-another-password-1' });
    expect(reuseRes.status).toBe(400);
  });

  it('bogus / well-formed-but-unknown code -> generic 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code: `cf_reset_${'a'.repeat(32)}`, newPassword: 'whatever-password-1' });
    expect(res.status).toBe(400);
  });

  it('weak newPassword (<8 chars) -> 400 from zod, code not consumed', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post('/api/v1/auth/reset-request').send({ username: 'forgetful' });
    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    const requestId = listRes.body[0].id;
    const approveRes = await adminAgent.post(`/api/v1/users/reset-requests/${requestId}/approve`);
    const code = approveRes.body.code;

    const shortRes = await request(server).post('/api/v1/auth/reset-confirm').send({ code, newPassword: 'short' });
    expect(shortRes.status).toBe(400);

    // Code survives the validation failure and still redeems.
    const okRes = await request(server).post('/api/v1/auth/reset-confirm').send({ code, newPassword: 'long-enough-password-1' });
    expect(okRes.status).toBe(204);
  });

  it('dismiss revokes an approved code', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post('/api/v1/auth/reset-request').send({ username: 'forgetful' });
    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    const requestId = listRes.body[0].id;
    const approveRes = await adminAgent.post(`/api/v1/users/reset-requests/${requestId}/approve`);
    const code = approveRes.body.code;

    const dismissRes = await adminAgent.delete(`/api/v1/users/reset-requests/${requestId}`);
    expect(dismissRes.status).toBe(204);

    const confirmRes = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code, newPassword: 'should-not-work-1' });
    expect(confirmRes.status).toBe(400);

    const listAfter = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listAfter.body).toHaveLength(0);
  });

  it('re-approving regenerates the code and kills the previous one', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post('/api/v1/auth/reset-request').send({ username: 'forgetful' });
    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    const requestId = listRes.body[0].id;

    const firstApprove = await adminAgent.post(`/api/v1/users/reset-requests/${requestId}/approve`);
    const secondApprove = await adminAgent.post(`/api/v1/users/reset-requests/${requestId}/approve`);
    expect(secondApprove.status).toBe(201);
    expect(secondApprove.body.code).not.toBe(firstApprove.body.code);

    const oldCodeRes = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code: firstApprove.body.code, newPassword: 'nope-password-1' });
    expect(oldCodeRes.status).toBe(400);

    const newCodeRes = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code: secondApprove.body.code, newPassword: 'regenerated-password-1' });
    expect(newCodeRes.status).toBe(204);
  });

  it('disabled account: request is silently ignored (202, no row); approving an existing request 409s', async () => {
    const server = ctx.app.getHttpServer();

    await adminAgent.post('/api/v1/users').send({ username: 'benched', password: 'benched-password-1', serverRole: 'user' });
    // File a request while still enabled, then disable.
    await request(server).post('/api/v1/auth/reset-request').send({ username: 'benched' });
    const lookup = await adminAgent.get('/api/v1/users/lookup').query({ query: 'benched' });
    const benchedId = lookup.body[0].id;
    await adminAgent.patch(`/api/v1/users/${benchedId}`).send({ disabled: true });

    const listRes = await adminAgent.get('/api/v1/users/reset-requests');
    const row = listRes.body.find((r: { username: string }) => r.username === 'benched');
    expect(row).toBeDefined();
    const approveRes = await adminAgent.post(`/api/v1/users/reset-requests/${row.id}/approve`);
    expect(approveRes.status).toBe(409);

    // A NEW request for the disabled account is silently swallowed (202, no extra row).
    const before = (await adminAgent.get('/api/v1/users/reset-requests')).body.length;
    await adminAgent.delete(`/api/v1/users/reset-requests/${row.id}`);
    const res = await request(server).post('/api/v1/auth/reset-request').send({ username: 'benched' });
    expect(res.status).toBe(202);
    const after = (await adminAgent.get('/api/v1/users/reset-requests')).body.length;
    expect(after).toBe(before - 1); // only the dismissed row disappeared; nothing new
  });

  it('deleting a user cascades their open reset request', async () => {
    const server = ctx.app.getHttpServer();
    await adminAgent.post('/api/v1/users').send({ username: 'leaver', password: 'leaver-password-1', serverRole: 'user' });
    await request(server).post('/api/v1/auth/reset-request').send({ username: 'leaver' });

    const lookup = await adminAgent.get('/api/v1/users/lookup').query({ query: 'leaver' });
    const leaverId = lookup.body[0].id;
    const listBefore = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listBefore.body.some((r: { username: string }) => r.username === 'leaver')).toBe(true);

    await adminAgent.delete(`/api/v1/users/${leaverId}`);

    const listAfter = await adminAgent.get('/api/v1/users/reset-requests');
    expect(listAfter.body.some((r: { username: string }) => r.username === 'leaver')).toBe(false);
  });

  it('approve/dismiss on a nonexistent request -> 404', async () => {
    const approveRes = await adminAgent.post('/api/v1/users/reset-requests/99999/approve');
    expect(approveRes.status).toBe(404);
    const dismissRes = await adminAgent.delete('/api/v1/users/reset-requests/99999');
    expect(dismissRes.status).toBe(404);
  });

  it('oversized code (>200 chars) -> 400 from zod', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/auth/reset-confirm')
      .send({ code: 'x'.repeat(300), newPassword: 'valid-password-1' });
    expect(res.status).toBe(400);
  });
});
