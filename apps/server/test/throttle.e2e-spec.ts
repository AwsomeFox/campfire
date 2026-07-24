import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';

/**
 * P2 fix pinning tests — see app.module.ts (ThrottlerModule + ThrottlerGuard),
 * common/throttle.constants.ts, auth.controller.ts (@Throttle on login/token/setup),
 * main.ts (trust proxy for correct per-IP tracking behind a reverse proxy).
 *
 * VERIFIED finding this closes: @Public auth endpoints (POST /auth/login,
 * /auth/token, /auth/setup) ran a full scrypt hash/verify (~30ms CPU) per
 * request with no rate limit — a valid-username, wrong-password flood could
 * burn CPU unbounded. Fix: a strict per-IP limit (AUTH_THROTTLE_LIMIT/TTL)
 * on those three routes specifically; a much looser default elsewhere so
 * normal API/MCP usage is unaffected.
 *
 * Unlike every other e2e suite (which goes through test/test-app.ts's helpers
 * and sets THROTTLE_DISABLED=1 to avoid flaking on rapid-fire auth calls),
 * this suite builds its app directly with throttling left ON, mirroring
 * main-hardening.e2e-spec.ts's pattern of calling the real configureApp().
 */
async function buildThrottledApp(): Promise<{ app: INestApplication; dataDir: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.DEV_AUTH;
  delete process.env.THROTTLE_DISABLED;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return { app, dataDir };
}

describe('rate limiting on @Public auth endpoints (e2e, real ThrottlerGuard)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    const built = await buildThrottledApp();
    app = built.app;
    dataDir = built.dataDir;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Restore the test-suite-wide default so any file that (re-)requires test-app.ts
    // helpers after this one still gets the opt-out — belt-and-suspenders; each helper
    // sets it again itself, but this avoids leaking `unset` to a suite that doesn't.
    process.env.THROTTLE_DISABLED = '1';
  });

  it('POST /auth/login: after AUTH_THROTTLE_LIMIT rapid requests from one IP, the next one is 429', async () => {
    const server = app.getHttpServer();
    const AUTH_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AUTH_THROTTLE_LIMIT; i++) {
      const res = await request(server).post('/api/v1/auth/login').send({ username: 'nobody', password: 'wrong-password-1' });
      statuses.push(res.status);
    }
    // All of the first LIMIT requests are normal auth failures (401 — unknown user), not 429.
    expect(statuses.every((s) => s === 401)).toBe(true);

    const overLimitRes = await request(server).post('/api/v1/auth/login').send({ username: 'nobody', password: 'wrong-password-1' });
    expect(overLimitRes.status).toBe(429);
  });

  it('POST /auth/token: the same strict limit applies independently of /auth/login (shared "auth" throttler bucket is per-route via generateKey)', async () => {
    const server = app.getHttpServer();
    const AUTH_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AUTH_THROTTLE_LIMIT + 1; i++) {
      const res = await request(server)
        .post('/api/v1/auth/token')
        .send({ username: 'nobody', password: 'wrong-password-1', tokenName: 'flood-attempt' });
      statuses.push(res.status);
    }
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('POST /auth/setup: also throttled (setup-spam / first-admin-race DoS)', async () => {
    const server = app.getHttpServer();
    const AUTH_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AUTH_THROTTLE_LIMIT + 1; i++) {
      // Deliberately invalid body (password too short) so none of these actually complete
      // setup — isolates the throttle behavior from setup's own one-time-only business rule.
      const res = await request(server).post('/api/v1/auth/setup').send({ username: `flood${i}`, password: 'x' });
      statuses.push(res.status);
    }
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('ordinary (non-auth) routes are effectively unaffected by the strict auth limit', async () => {
    const server = app.getHttpServer();
    // /auth/status is @Public but NOT one of the three throttled routes — many rapid
    // hits should sail through under the loose default limit.
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request(server).get('/api/v1/auth/status');
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('healthz stays responsive under the same burst that trips the auth throttle', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 15; i++) {
      const res = await request(server).get('/healthz');
      expect(res.status).toBe(200);
    }
  });
});

/**
 * AI Rate Limiting & Governance Complementarity:
 * Rate throttling (@nestjs/throttler) and application budget checks (token budgets / seat limits)
 * serve complementary roles in the AI architecture:
 *
 * 1. Rate Throttling (HTTP Layer / Network Level):
 *    - Keyed per authenticated user with a 1-minute TTL; unauthenticated attempts fall back to IP.
 *    - Rejects burst floods (e.g. prompt-injection loops, client retry storms, unauthenticated/spam attempts)
 *      immediately with HTTP 429 (Too Many Requests).
 *    - Protects server compute and prevents rapid-fire provider API key depletion within seconds/minutes.
 *
 * 2. Budget Checks (Domain Layer / Application Level):
 *    - Evaluated inside services (AiDmService, ScribeService, CoDmService) against campaign/server token caps.
 *    - Rejects invocations with HTTP 403 (Forbidden) or HTTP 503 (Service Unavailable) when monthly/cumulative
 *      token budgets are exhausted.
 *    - Protects overall financial expenditure and enforces long-term AI resource limits per seat/campaign.
 */
describe('rate limiting on AI invocation routes (e2e, AI throttler)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    const built = await buildThrottledApp();
    app = built.app;
    dataDir = built.dataDir;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.THROTTLE_DISABLED = '1';
  });

  it('POST /settings/ai-provider/test: two authenticated users behind one IP get independent AI buckets', async () => {
    const server = app.getHttpServer();
    const AI_THROTTLE_LIMIT = 10;
    const sameIp = '198.51.100.105';

    const adminA = request.agent(server);
    const setupRes = await adminA
      .post('/api/v1/auth/setup')
      .set('X-Forwarded-For', sameIp)
      .send({ username: 'ai-throttle-admin-a', password: 'admin-a-password-1' });
    expect(setupRes.status).toBe(201);

    const createAdminBRes = await adminA
      .post('/api/v1/users')
      .set('X-Forwarded-For', sameIp)
      .send({ username: 'ai-throttle-admin-b', password: 'admin-b-password-1', serverRole: 'admin' });
    expect(createAdminBRes.status).toBe(201);

    const adminB = request.agent(server);
    const loginAdminBRes = await adminB
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', sameIp)
      .send({ username: 'ai-throttle-admin-b', password: 'admin-b-password-1' });
    expect(loginAdminBRes.status).toBe(201);

    const postProviderTest = (agent: ReturnType<typeof request.agent>) =>
      agent.post('/api/v1/settings/ai-provider/test').set('X-Forwarded-For', sameIp).send({});

    const statuses: number[] = [];
    for (let i = 0; i < AI_THROTTLE_LIMIT; i++) {
      const res = await postProviderTest(adminA);
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s !== 429)).toBe(true);

    const sameUserOverLimitRes = await postProviderTest(adminA);
    expect(sameUserOverLimitRes.status).toBe(429);

    const differentUserSameIpRes = await postProviderTest(adminB);
    expect(differentUserSameIpRes.status).not.toBe(429);
  });

  it('POST /campaigns/1/ai-dm/message: after 10 rapid requests from one IP, the 11th returns 429', async () => {
    const server = app.getHttpServer();
    const AI_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AI_THROTTLE_LIMIT; i++) {
      const res = await request(server).post('/api/v1/campaigns/1/ai-dm/message').send({ input: 'hello' });
      statuses.push(res.status);
    }
    // Requests prior to limit hit authorization / seat guards (401), not 429.
    expect(statuses.every((s) => s !== 429)).toBe(true);

    const overLimitRes = await request(server).post('/api/v1/campaigns/1/ai-dm/message').send({ input: 'hello' });
    expect(overLimitRes.status).toBe(429);
  });

  it('POST /campaigns/1/scribe/run: exceeding 10 requests/min returns 429 Too Many Requests', async () => {
    const server = app.getHttpServer();
    const AI_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AI_THROTTLE_LIMIT + 1; i++) {
      const res = await request(server).post('/api/v1/campaigns/1/scribe/run').send({});
      statuses.push(res.status);
    }
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('POST /settings/ai-provider/test: exceeding 10 requests/min returns 429 Too Many Requests', async () => {
    const server = app.getHttpServer();
    const AI_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AI_THROTTLE_LIMIT + 1; i++) {
      const res = await request(server).post('/api/v1/settings/ai-provider/test').send({});
      statuses.push(res.status);
    }
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('POST /campaigns/1/ai-provider/test: exceeding 10 requests/min returns 429 Too Many Requests', async () => {
    const server = app.getHttpServer();
    const AI_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AI_THROTTLE_LIMIT + 1; i++) {
      const res = await request(server).post('/api/v1/campaigns/1/ai-provider/test').send({});
      statuses.push(res.status);
    }
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('POST /campaigns/1/ai-dm/nudge: exceeding 10 requests/min returns 429 Too Many Requests', async () => {
    const server = app.getHttpServer();
    const AI_THROTTLE_LIMIT = 10;

    const statuses: number[] = [];
    for (let i = 0; i < AI_THROTTLE_LIMIT + 1; i++) {
      const res = await request(server).post('/api/v1/campaigns/1/ai-dm/nudge').send({});
      statuses.push(res.status);
    }
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});

