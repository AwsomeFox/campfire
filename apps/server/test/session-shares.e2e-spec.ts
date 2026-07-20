import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-1' };
const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'viewer-1' };

const SHARE_TOKEN_RE = /^cf_share_[0-9a-f]{48}$/;

/**
 * Issue #12 — read-only recap share links.
 * DM mints an unguessable capability token for one session recap; anyone with
 * the link reads it via the @Public GET /shared/recaps/:token endpoint (no
 * account). Tokens are stored hashed, revocable (DELETE), and the public
 * endpoint is per-IP rate-limited (named 'share' throttler, same pattern as
 * the auth-route throttling — see throttle.e2e-spec.ts).
 */
describe('session share links (e2e) — mint/list/revoke + public resolution', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let sessionId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Share Links Campaign' });
    campaignId = campRes.body.id;
    const sessRes = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({
      number: 1,
      title: 'The Dragon’s Shadow',
      playedAt: '2026-07-01',
      recap: '# What happened\n\nThe party met **Gundren** in Phandalin.',
    });
    sessionId = sessRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM creates a share link: 201, unguessable token shown once, hash never leaked', async () => {
    const server = ctx.app.getHttpServer();

    const res = await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(SHARE_TOKEN_RE);
    expect(res.body.share.sessionId).toBe(sessionId);
    expect(res.body.share.campaignId).toBe(campaignId);
    expect(res.body.share.tokenPrefix).toBe(res.body.token.slice(0, 13));
    expect(res.body.share.tokenHash).toBeUndefined();

    // List shows display metadata only — no raw token, no hash.
    const listRes = await request(server).get(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].tokenPrefix).toBe(res.body.share.tokenPrefix);
    expect(listRes.body[0].token).toBeUndefined();
    expect(listRes.body[0].tokenHash).toBeUndefined();

    // The public endpoint resolves the token to the recap payload.
    const publicRes = await request(server).get(`/api/v1/shared/recaps/${res.body.token}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body).toEqual({
      campaignName: 'Share Links Campaign',
      sessionNumber: 1,
      title: 'The Dragon’s Shadow',
      playedAt: '2026-07-01',
      recap: '# What happened\n\nThe party met **Gundren** in Phandalin.',
    });

    // cleanup so later tests start from a known state
    const delRes = await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${res.body.share.id}`).set(dm);
    expect(delRes.status).toBe(200);
  });

  it('players and viewers cannot mint, list, or revoke share links (403)', async () => {
    const server = ctx.app.getHttpServer();

    expect((await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(player)).status).toBe(403);
    expect((await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(viewer)).status).toBe(403);
    expect((await request(server).get(`/api/v1/sessions/${sessionId}/shares`).set(player)).status).toBe(403);

    const created = await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    expect(created.status).toBe(201);
    expect((await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${created.body.share.id}`).set(player)).status).toBe(403);

    // still revocable by the DM
    expect((await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${created.body.share.id}`).set(dm)).status).toBe(200);
  });

  it('unknown, malformed, and revoked tokens all resolve to a uniform 404', async () => {
    const server = ctx.app.getHttpServer();

    // Well-formed but unknown.
    const unknown = `cf_share_${'ab'.repeat(24)}`;
    expect((await request(server).get(`/api/v1/shared/recaps/${unknown}`)).status).toBe(404);

    // Malformed (wrong prefix / wrong length / not hex).
    expect((await request(server).get('/api/v1/shared/recaps/not-a-token')).status).toBe(404);
    expect((await request(server).get('/api/v1/shared/recaps/cf_share_tooshort')).status).toBe(404);

    // Revoked: works before, 404 after.
    const created = await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    expect((await request(server).get(`/api/v1/shared/recaps/${created.body.token}`)).status).toBe(200);

    const delRes = await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${created.body.share.id}`).set(dm);
    expect(delRes.status).toBe(200);
    expect((await request(server).get(`/api/v1/shared/recaps/${created.body.token}`)).status).toBe(404);

    // Revoking again (or revoking a nonexistent id) is 404, not a crash.
    expect((await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${created.body.share.id}`).set(dm)).status).toBe(404);
  });

  it('a share id cannot be revoked through a different session (404 on mismatch)', async () => {
    const server = ctx.app.getHttpServer();

    const otherSess = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 2 });
    const created = await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(dm);

    const crossRes = await request(server).delete(`/api/v1/sessions/${otherSess.body.id}/shares/${created.body.share.id}`).set(dm);
    expect(crossRes.status).toBe(404);

    // Untouched: the link still resolves; clean up via the right session.
    expect((await request(server).get(`/api/v1/shared/recaps/${created.body.token}`)).status).toBe(200);
    expect((await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${created.body.share.id}`).set(dm)).status).toBe(200);
    expect((await request(server).delete(`/api/v1/sessions/${otherSess.body.id}`).set(dm)).status).toBe(200);
  });

  it('deleting the session kills its share links', async () => {
    const server = ctx.app.getHttpServer();

    const sessRes = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 3, recap: 'Short-lived.' });
    const created = await request(server).post(`/api/v1/sessions/${sessRes.body.id}/shares`).set(dm);
    expect((await request(server).get(`/api/v1/shared/recaps/${created.body.token}`)).status).toBe(200);

    expect((await request(server).delete(`/api/v1/sessions/${sessRes.body.id}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/shared/recaps/${created.body.token}`)).status).toBe(404);
  });

  it('each mint produces a distinct token; multiple links stay independently revocable', async () => {
    const server = ctx.app.getHttpServer();

    const a = await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    const b = await request(server).post(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    expect(a.body.token).not.toBe(b.body.token);

    const listRes = await request(server).get(`/api/v1/sessions/${sessionId}/shares`).set(dm);
    expect(listRes.body).toHaveLength(2);

    // Revoking one leaves the other working.
    expect((await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${a.body.share.id}`).set(dm)).status).toBe(200);
    expect((await request(server).get(`/api/v1/shared/recaps/${a.body.token}`)).status).toBe(404);
    expect((await request(server).get(`/api/v1/shared/recaps/${b.body.token}`)).status).toBe(200);

    expect((await request(server).delete(`/api/v1/sessions/${sessionId}/shares/${b.body.share.id}`).set(dm)).status).toBe(200);
  });
});

describe('session share links (e2e) — truly public, DEV_AUTH unset', () => {
  let ctx: TestAppContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // Real cookie-session admin (admins are dm everywhere) mints the link.
    const agent = request.agent(server);
    const setupRes = await agent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'correct-horse-battery' });
    expect(setupRes.status).toBe(201);

    const campRes = await agent.post('/api/v1/campaigns').send({ name: 'Public Share Campaign' });
    const sessRes = await agent.post(`/api/v1/campaigns/${campRes.body.id}/sessions`).send({ number: 1, recap: 'Catch-up recap.' });
    const shareRes = await agent.post(`/api/v1/sessions/${sessRes.body.id}/shares`);
    expect(shareRes.status).toBe(201);
    token = shareRes.body.token;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('the shared recap is readable with NO auth at all; protected routes still 401', async () => {
    const server = ctx.app.getHttpServer();

    // No cookie, no bearer, no dev headers.
    const publicRes = await request(server).get(`/api/v1/shared/recaps/${token}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.recap).toBe('Catch-up recap.');
    expect(publicRes.body.campaignName).toBe('Public Share Campaign');

    // Sanity contrast: the authed sessions API is still locked down.
    expect((await request(server).get('/api/v1/campaigns')).status).toBe(401);
  });

  it('anonymous visitors cannot mint or revoke share links (401)', async () => {
    const server = ctx.app.getHttpServer();
    expect((await request(server).post('/api/v1/sessions/1/shares')).status).toBe(401);
    expect((await request(server).get('/api/v1/sessions/1/shares')).status).toBe(401);
    expect((await request(server).delete('/api/v1/sessions/1/shares/1')).status).toBe(401);
  });
});

/**
 * Real-throttler suite: mirrors throttle.e2e-spec.ts's pattern — builds its app
 * directly with THROTTLE_DISABLED unset and the real configureApp(), so the
 * named 'share' throttler actually enforces its per-IP cap.
 */
describe('session share links (e2e) — public endpoint rate limiting (real ThrottlerGuard)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.DEV_AUTH;
    delete process.env.THROTTLE_DISABLED;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Restore the suite-wide default — same belt-and-suspenders as throttle.e2e-spec.ts.
    process.env.THROTTLE_DISABLED = '1';
  });

  it('GET /shared/recaps/:token: after SHARE_THROTTLE_LIMIT rapid requests from one IP, the next one is 429', async () => {
    const server = app.getHttpServer();
    const SHARE_THROTTLE_LIMIT = 30;

    const unknown = `cf_share_${'cd'.repeat(24)}`;
    const statuses: number[] = [];
    for (let i = 0; i < SHARE_THROTTLE_LIMIT; i++) {
      const res = await request(server).get(`/api/v1/shared/recaps/${unknown}`);
      statuses.push(res.status);
    }
    // All of the first LIMIT requests are normal lookups (404 — unknown token), not 429.
    expect(statuses.every((s) => s === 404)).toBe(true);

    const overLimitRes = await request(server).get(`/api/v1/shared/recaps/${unknown}`);
    expect(overLimitRes.status).toBe(429);
  });
});
