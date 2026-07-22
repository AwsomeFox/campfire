import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { SESSION_COOKIE_NAME } from '../src/modules/auth/auth.constants';

/**
 * Regression for issue #525: POST /invites/:code/accept issues the same session
 * cookie as /auth/login, so it must honor resolveCookieSecure() — i.e. on a
 * production deployment with ALLOW_INSECURE_HTTP=1 (the documented plain-HTTP
 * homelab path), the cookie is NOT marked Secure. A Secure cookie is silently
 * dropped over plain HTTP, so the just-created account immediately hits a login
 * loop on its very next request.
 *
 * The sibling /login route was fixed the same way in issue #117; invites was the
 * lone holdout because it duplicated the cookie helper (and hardcoded `secure`)
 * instead of importing the shared resolver. This suite is the route-specific
 * regression a #117 test cannot catch.
 *
 * Bootstraps with NODE_ENV=production + ALLOW_INSECURE_HTTP=1 BEFORE AppModule
 * compiles so resolveCookieSecure() reads the same env the live server would.
 */
describe('invite-accept session cookie honors ALLOW_INSECURE_HTTP (e2e, issue #525)', () => {
  let app: INestApplication;
  let dataDir: string;
  // Capture every env var this suite mutates so afterAll can restore the lot —
  // Jest reuses a worker across files, so a leftover DATA_DIR pointing at a
  // removed dir or a sticky THROTTLE_DISABLED leaks into later suites.
  const originalNodeEnv = process.env.NODE_ENV;
  const originalInsecure = process.env.ALLOW_INSECURE_HTTP;
  const originalDevAuth = process.env.DEV_AUTH;
  const originalDataDir = process.env.DATA_DIR;
  const originalThrottle = process.env.THROTTLE_DISABLED;

  // Shared fixtures created once in beforeAll so each `it` is order-independent
  // (a single test can be run in isolation without relying on another's setup).
  let adminAgent: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    // Set before AppModule compiles — resolveCookieSecure() reads these at
    // request time, but main bootstrap (helmet/HSTS) reads them at init; mirror
    // main-hardening.e2e-spec.ts's env-management pattern and set both up front.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_INSECURE_HTTP = '1';
    // DEV_AUTH is hard-gated off in production (isDevAuthActive()), so the setup
    // below uses a real cookie session — same as invites.e2e-spec.ts.
    delete process.env.DEV_AUTH;
    process.env.THROTTLE_DISABLED = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', {
      exclude: [
        'healthz',
        'readyz',
        'mcp',
        '.well-known/oauth-protected-resource',
        '.well-known/oauth-protected-resource/mcp',
        '.well-known/oauth-authorization-server',
        '.well-known/oauth-authorization-server/mcp',
        'oauth/register',
        'oauth/authorize',
        'oauth/token',
        'oauth/revoke',
        'api/docs',
        'api/docs-json',
        'api/openapi.json',
      ],
    });
    await app.init();

    // First-run admin + a DM, both authenticated via real cookie sessions. Done
    // once here so either `it` below can run standalone.
    const server = app.getHttpServer();
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'dm-dana', password: 'dm-password-1', serverRole: 'user' });
    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'dm-dana', password: 'dm-password-1' });
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalInsecure === undefined) delete process.env.ALLOW_INSECURE_HTTP;
    else process.env.ALLOW_INSECURE_HTTP = originalInsecure;
    if (originalDevAuth === undefined) delete process.env.DEV_AUTH;
    else process.env.DEV_AUTH = originalDevAuth;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalThrottle === undefined) delete process.env.THROTTLE_DISABLED;
    else process.env.THROTTLE_DISABLED = originalThrottle;
  });

  /**
   * Asserts whether a Set-Cookie header carries the `Secure` attribute by looking
   * for the attribute at an attribute boundary (start-of-attributes or after `; `)
   * rather than a bare substring. A naive `not.toContain('secure')` would false-fail
   * if the cookie value or path ever happened to contain that substring.
   */
  function hasSecureAttribute(cookieHeader: string): boolean {
    const normalized = cookieHeader.toLowerCase();
    // Cookie attrs are `;`-separated; `secure` is a bare flag (no `=`). Match it
    // either at the start of the attribute list or after a `; ` separator.
    return /(?:^|;\s*)secure(?:;|$)/.test(normalized);
  }

  it('accept sets a session cookie that is NOT marked Secure (homelab plain-HTTP path works)', async () => {
    const server = app.getHttpServer();
    const campaignRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'The Ember Vale' });
    const campaignId = campaignRes.body.id;
    const inviteRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'player' });
    const code: string = inviteRes.body.code;

    const res = await request(server).post(`/api/v1/invites/${code}/accept`).send({
      username: 'new-nadia',
      password: 'nadia-password-1',
      displayName: 'Nadia',
    });
    expect(res.status).toBe(201);

    // Set-Cookie is present (accept issued a session)…
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieHeader).toContain(SESSION_COOKIE_NAME);

    // …and crucially it is NOT marked Secure — a Secure cookie over plain HTTP
    // is silently dropped by the browser, which is exactly the login loop #525
    // reports (same bug class as #117 on /login, re-introduced here because the
    // helper was duplicated instead of imported). Before the fix this branch
    // hardcodes `secure: NODE_ENV === 'production'` == true here, so the cookie
    // carries `; Secure` and this assertion fails.
    expect(hasSecureAttribute(cookieHeader)).toBe(false);
  });

  it('the just-accepted session actually authenticates the next request (no login loop)', async () => {
    // The whole point of dropping `Secure`: the new user must be able to USE the
    // cookie their browser will now actually retain over plain HTTP.
    const campaignRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Second Vale' });
    const campaignId = campaignRes.body.id;
    const inviteRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/invites`).send({ role: 'player' });
    const code: string = inviteRes.body.code;

    // A supertest .agent() replays the Set-Cookie from accept onto /me. Unlike a
    // real browser cookie jar (which DROPS a Secure cookie over HTTP — that's the
    // bug), supertest's tough-cookie keeps it regardless of scheme, so /me 200s
    // here even on the unpatched code. The previous test is the one that actually
    // proves the Secure flag is gone; this one proves the accepted session is
    // usable at all once the cookie is retained.
    const newbie = request.agent(server());
    const acceptRes = await newbie.post(`/api/v1/invites/${code}/accept`).send({
      username: 'loop-leo',
      password: 'leo-password-1',
    });
    expect(acceptRes.status).toBe(201);

    const meRes = await newbie.get('/api/v1/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.username).toBe('loop-leo');
  });

  function server() {
    return app.getHttpServer();
  }
});
