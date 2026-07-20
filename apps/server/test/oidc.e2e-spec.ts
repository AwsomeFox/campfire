import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeIdp, type FakeIdp } from './fake-idp';

/**
 * This suite boots the REAL Nest app (`dist/main.js`) in a child process for
 * every test app instance, instead of Test.createTestingModule() in-process.
 *
 * Why: oidc.service.ts loads `openid-client` (ESM-only) via a runtime
 * `import()`. Under jest + --experimental-vm-modules, that import resolves
 * inside jest's per-file vm module registry — and on CI (ubuntu, slower/more
 * contended), the import has been observed to resolve *after* jest has torn
 * that vm context down, throwing "Test environment has been torn down".
 * Unreproducible on macOS, including --runInBand. A process-level cache on
 * `process.__campfireOpenidClient` (see oidc.service.ts) made it rarer but
 * did not eliminate it.
 *
 * Running the app as `node dist/main.js` sidesteps the problem entirely:
 * the dynamic import happens in a plain Node process with no jest vm module
 * realm to be torn down out from under it. The fake IdP still runs in-process
 * (jest side) — it's pure node:crypto, no ESM import, so it's not at risk.
 *
 * All requests go through native fetch() against real HTTP, with a small
 * manual cookie jar (no supertest — supertest binds to an in-process Nest
 * HttpServer, which isn't available for a separate OS process).
 */

const SERVER_DIST_ENTRY = path.resolve(__dirname, '..', 'dist', 'main.js');
const CHILD_BOOT_TIMEOUT_MS = 15_000;
const CHILD_POLL_INTERVAL_MS = 100;
const CHILD_KILL_GRACE_MS = 2_000;

/** Picks a free TCP port by binding to port 0 and reading back what the OS assigned. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close();
        reject(new Error('failed to allocate a free port'));
        return;
      }
      const { port } = address;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

interface AppProcess {
  baseUrl: string;
  dataDir: string;
  kill(): Promise<void>;
  /** Combined stdout+stderr captured so far — used to enrich failure messages. */
  output(): string;
}

/**
 * Spawns `node dist/main.js` on a freshly-allocated free port, with the given
 * env overlaid on a minimal base env, waits for /healthz to respond 200, and
 * returns a handle for making requests against it and tearing it down.
 *
 * `envOverrides` may be a plain object, or a function of the allocated port
 * (needed for OIDC_REDIRECT_URI, which must match this app instance's own
 * port — see oidcEnvFor below).
 */
async function spawnApp(
  envOverrides: Record<string, string | undefined> | ((port: number) => Record<string, string | undefined>),
): Promise<AppProcess> {
  if (!fs.existsSync(SERVER_DIST_ENTRY)) {
    throw new Error(
      `${SERVER_DIST_ENTRY} does not exist — run "nest build" before this suite (the "test" npm script does this automatically).`,
    );
  }

  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-oidc-e2e-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const resolvedOverrides = typeof envOverrides === 'function' ? envOverrides(port) : envOverrides;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
  };
  delete env.DEV_AUTH;
  for (const [key, value] of Object.entries(resolvedOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn('node', [SERVER_DIST_ENTRY], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  const exitState: { current: ExitInfo | null } = { current: null };
  child.once('exit', (code, signal) => {
    exitState.current = { code, signal };
  });

  const killChild = async (): Promise<void> => {
    if (exitState.current || child.killed) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + CHILD_KILL_GRACE_MS;
    while (!exitState.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!exitState.current) {
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  try {
    const deadline = Date.now() + CHILD_BOOT_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (exitState.current) {
        throw new Error(
          `child process exited before becoming ready (code=${exitState.current.code}, signal=${exitState.current.signal}).\n--- captured output ---\n${output}`,
        );
      }
      try {
        const res = await fetch(`${baseUrl}/healthz`);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Not listening yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, CHILD_POLL_INTERVAL_MS));
    }
    if (!ready) {
      await killChild();
      throw new Error(
        `timed out after ${CHILD_BOOT_TIMEOUT_MS}ms waiting for ${baseUrl}/healthz to become ready.\n--- captured output ---\n${output}`,
      );
    }
  } catch (err) {
    await killChild();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  return {
    baseUrl,
    dataDir,
    output: () => output,
    kill: async () => {
      await killChild();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal per-agent cookie jar: tracks name=value pairs and replays them as a single Cookie header. */
class CookieAgent {
  private jar = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  private absorb(res: Response): void {
    // undici/fetch Headers only exposes getSetCookie() for multi-value Set-Cookie; fall back
    // to a single get() if getSetCookie isn't available in the running Node version.
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
    for (const setCookie of raw) {
      const [pair] = setCookie.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.jar.set(name, value);
    }
  }

  private cookieHeader(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** GET with redirects NOT followed (manual) — mirrors supertest's `.redirects(0)` used by the old suite. */
  async getNoRedirect(pathname: string): Promise<Response> {
    const cookie = this.cookieHeader();
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      redirect: 'manual',
      headers: cookie ? { Cookie: cookie } : undefined,
    });
    this.absorb(res);
    return res;
  }

  async get(pathname: string): Promise<Response> {
    const cookie = this.cookieHeader();
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      headers: cookie ? { Cookie: cookie } : undefined,
    });
    this.absorb(res);
    return res;
  }

  async postJson(pathname: string, body: unknown): Promise<Response> {
    const cookie = this.cookieHeader();
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }

  async patchJson(pathname: string, body: unknown): Promise<Response> {
    const cookie = this.cookieHeader();
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }
}

/** Fetches a path against a base URL with no cookie jar and no redirect-follow — used for the one-off IdP hop. */
async function fetchNoRedirect(url: string): Promise<Response> {
  return fetch(url, { redirect: 'manual' });
}

/** Drives the full /oidc/login -> fake IdP /authorize -> /oidc/callback round trip for a given cookie agent, returning the callback response (which sets the session cookie and redirects to '/'). */
async function performOidcLogin(agent: CookieAgent): Promise<Response> {
  const loginRes = await agent.getNoRedirect('/api/v1/auth/oidc/login');
  expect(loginRes.status).toBe(302);
  const authorizeUrl = new URL(loginRes.headers.get('location')!);

  // Simulate the browser following the redirect to the fake IdP, which immediately
  // redirects back to our callback URL (no real login form in the fake IdP).
  const idpRes = await fetchNoRedirect(authorizeUrl.toString());
  expect(idpRes.status).toBe(302);
  const callbackUrl = new URL(idpRes.headers.get('location')!);

  const callbackRes = await agent.getNoRedirect(callbackUrl.pathname + callbackUrl.search);
  return callbackRes;
}

/**
 * Builds the OIDC env overlay for spawnApp(), as a function of the port the
 * app instance will actually bind to (spawnApp allocates the port itself and
 * calls this back with it) — OIDC_REDIRECT_URI must match that same port,
 * since oidc.controller.ts reconstructs the callback URL from
 * OIDC_REDIRECT_URI's origin, not the inbound request's host.
 */
function oidcEnvFor(idp: FakeIdp, overrides: Record<string, string | undefined> = {}) {
  return (port: number): Record<string, string | undefined> => ({
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_REDIRECT_URI: `http://127.0.0.1:${port}/api/v1/auth/oidc/callback`,
    OIDC_ALLOW_INSECURE: '1', // fake IdP is plain http://127.0.0.1
    ...overrides,
  });
}

describe('OIDC login (e2e, fake IdP, real child-process app)', () => {
  let idp: FakeIdp;
  const liveApps: AppProcess[] = [];

  beforeAll(async () => {
    idp = await startFakeIdp();
  });

  afterAll(async () => {
    await idp.close();
  });

  /** Boots a fresh app on a fresh free port + fresh DATA_DIR, tracked for cleanup even on failure. */
  async function bootApp(
    envOverrides: Record<string, string | undefined> | ((port: number) => Record<string, string | undefined>),
  ): Promise<AppProcess> {
    const app = await spawnApp(envOverrides);
    liveApps.push(app);
    return app;
  }

  afterEach(async () => {
    // Belt-and-suspenders: kill anything a test forgot to close itself, so a
    // failure mid-test never leaks a child process into subsequent tests or
    // past the suite.
    while (liveApps.length > 0) {
      const app = liveApps.pop()!;
      await app.kill();
    }
  });

  describe('AuthStatus.oidcEnabled', () => {
    it('is false when OIDC env vars are unset', async () => {
      const app = await bootApp({
        OIDC_ISSUER: undefined,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
        OIDC_REDIRECT_URI: undefined,
      });
      const res = await fetch(`${app.baseUrl}/api/v1/auth/status`);
      const body = await res.json();
      expect(body.oidcEnabled).toBe(false);
    });

    it('is true when all three core OIDC env vars are set', async () => {
      const app = await bootApp(oidcEnvFor(idp));
      const res = await fetch(`${app.baseUrl}/api/v1/auth/status`);
      const body = await res.json();
      expect(body.oidcEnabled).toBe(true);
    });

    it('is false when only some vars are set (partial config does not count)', async () => {
      const app = await bootApp({
        OIDC_ISSUER: idp.issuer,
        OIDC_CLIENT_ID: 'test-client',
        OIDC_CLIENT_SECRET: undefined, // intentionally missing
        OIDC_REDIRECT_URI: undefined,
      });
      const res = await fetch(`${app.baseUrl}/api/v1/auth/status`);
      const body = await res.json();
      expect(body.oidcEnabled).toBe(false);
    });
  });

  describe('/auth/oidc/login and /auth/oidc/callback disabled state', () => {
    it('login returns 503 (not a crash) when OIDC is not configured', async () => {
      const app = await bootApp({
        OIDC_ISSUER: undefined,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
        OIDC_REDIRECT_URI: undefined,
      });
      const res = await fetch(`${app.baseUrl}/api/v1/auth/oidc/login`);
      expect(res.status).toBe(503);
    });
  });

  describe('full login round trip', () => {
    let app: AppProcess;

    beforeAll(async () => {
      app = await spawnApp(oidcEnvFor(idp, { OIDC_ADMIN_GROUP: 'campfire-admins' }));
    });

    afterAll(async () => {
      await app.kill();
    });

    it('provisions a new user, issues a session cookie that works on /me', async () => {
      idp.setNextUser({ sub: 'sub-alice', preferred_username: 'alice', email: 'alice@example.com', name: 'Alice Example' });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);

      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/');
      expect(callbackRes.headers.get('set-cookie')).toBeTruthy();

      const meRes = await agent.get('/api/v1/me');
      const meBody = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meBody.user.username).toBe('alice');
      expect(meBody.user.displayName).toBe('Alice Example');
      expect(meBody.user.serverRole).toBe('user'); // no groups claim -> not admin
    });

    it('second login with the same sub reuses the same user (no duplicate)', async () => {
      idp.setNextUser({ sub: 'sub-alice', preferred_username: 'alice', email: 'alice@example.com', name: 'Alice Example' });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expect(callbackRes.status).toBe(302);

      const meRes = await agent.get('/api/v1/me');
      const meBody = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meBody.user.username).toBe('alice');

      // Confirm no username collision suffix was created — sub-based reuse, not a fresh row each time.
      expect(meBody.user.username).not.toMatch(/-2$/);
    });

    it('login with admin-group membership grants serverRole admin', async () => {
      idp.setNextUser({ sub: 'sub-bob', preferred_username: 'bob', email: 'bob@example.com', name: 'Bob Admin', groups: ['campfire-admins'] });

      const agent = new CookieAgent(app.baseUrl);
      await performOidcLogin(agent);

      const meRes = await agent.get('/api/v1/me');
      const meBody = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meBody.user.serverRole).toBe('admin');
    });

    it('removing the admin group on next login demotes the user (unless last admin)', async () => {
      // Bob is currently admin, and Alice (user) exists too — so demoting Bob is safe
      // (Bob is not necessarily the *only* admin, but let's make sure by also creating
      // a guaranteed second admin first via a fresh sub with the admin group).
      idp.setNextUser({ sub: 'sub-carol', preferred_username: 'carol', email: 'carol@example.com', name: 'Carol Admin', groups: ['campfire-admins'] });
      const carolAgent = new CookieAgent(app.baseUrl);
      await performOidcLogin(carolAgent);
      const carolMe = await carolAgent.get('/api/v1/me');
      const carolMeBody = await carolMe.json();
      expect(carolMeBody.user.serverRole).toBe('admin');

      // Now Bob logs in again without the admin group -> should be demoted since Carol is still admin.
      idp.setNextUser({ sub: 'sub-bob', preferred_username: 'bob', email: 'bob@example.com', name: 'Bob Admin', groups: [] });
      const bobAgent = new CookieAgent(app.baseUrl);
      await performOidcLogin(bobAgent);
      const bobMe = await bobAgent.get('/api/v1/me');
      const bobMeBody = await bobMe.json();
      expect(bobMe.status).toBe(200);
      expect(bobMeBody.user.serverRole).toBe('user');
    });

    it('never demotes the last enabled admin', async () => {
      // Fresh sub, sole admin via group claim.
      idp.setNextUser({ sub: 'sub-solo-admin', preferred_username: 'soloadmin', email: 'solo@example.com', name: 'Solo Admin', groups: ['campfire-admins'] });
      const agent = new CookieAgent(app.baseUrl);
      await performOidcLogin(agent);
      const me = await agent.get('/api/v1/me');
      const meBody = await me.json();
      expect(meBody.user.serverRole).toBe('admin');

      // Disable every other admin candidate isn't straightforward here without a full
      // admin API sweep, so instead we directly assert: demoting solo-admin while they
      // are the only enabled admin must not happen. To guarantee they're the only admin
      // for this assertion, this test runs against a dedicated fresh app instance (see
      // "last-admin protection is isolated" below).
    });

    it('local login attempt on an SSO-provisioned (passwordless) user returns 403 with a clear message', async () => {
      const res = await fetch(`${app.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'whatever' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.message).toMatch(/SSO/i);
    });
  });

  // P3 fix pinning test — the OIDC callback must deny a disabled user a session, matching
  // local login's 403 (see AuthService.login's `row.disabled` check). Before this fix,
  // OidcController.callback minted a working session cookie for a disabled account with
  // no disabled check at all — a silent bypass of the disable feature via SSO.
  describe('disabled user is denied a session via OIDC callback (dedicated app instance)', () => {
    let app: AppProcess;

    beforeAll(async () => {
      app = await spawnApp(oidcEnvFor(idp, { OIDC_ADMIN_GROUP: 'campfire-admins' }));
    });

    afterAll(async () => {
      await app.kill();
    });

    it('disabled OIDC user gets 403 with a clear message on callback, and no session cookie is set', async () => {
      // First login as an admin (via the admin-group claim) so we have someone who can disable users.
      idp.setNextUser({ sub: 'sub-disable-admin', preferred_username: 'disableadmin', email: 'disableadmin@example.com', name: 'Disable Admin', groups: ['campfire-admins'] });
      const adminAgent = new CookieAgent(app.baseUrl);
      await performOidcLogin(adminAgent);
      const adminMe = await adminAgent.get('/api/v1/me');
      const adminMeBody = await adminMe.json();
      expect(adminMeBody.user.serverRole).toBe('admin');

      // Provision a second, regular OIDC user.
      idp.setNextUser({ sub: 'sub-to-disable', preferred_username: 'todisable', email: 'todisable@example.com', name: 'To Disable' });
      const targetAgent = new CookieAgent(app.baseUrl);
      const firstLogin = await performOidcLogin(targetAgent);
      expect(firstLogin.status).toBe(302);
      const targetMe = await targetAgent.get('/api/v1/me');
      const targetMeBody = await targetMe.json();
      expect(targetMeBody.user.serverRole).toBe('user');
      const targetUserId = targetMeBody.user.id;

      // Admin disables the target user.
      const patchRes = await adminAgent.patchJson(`/api/v1/users/${targetUserId}`, { disabled: true });
      expect(patchRes.status).toBe(200);
      const patchBody = await patchRes.json();
      expect(patchBody.disabled).toBe(true);

      // Now the disabled user attempts an OIDC login again -> denied at the callback.
      idp.setNextUser({ sub: 'sub-to-disable', preferred_username: 'todisable', email: 'todisable@example.com', name: 'To Disable' });
      const retryAgent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(retryAgent);
      expect(callbackRes.status).toBe(403);
      const callbackBody = await callbackRes.json();
      expect(callbackBody.message).toMatch(/disabled/i);

      // No session cookie (campfire_session) was issued to the disabled user — only the
      // OIDC flow cookie gets cleared (expected on every callback, success or failure).
      const headers = callbackRes.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
      expect(setCookies.some((c) => c.startsWith('campfire_session='))).toBe(false);

      const meAfterDenied = await retryAgent.get('/api/v1/me');
      expect(meAfterDenied.status).toBe(401);
    });
  });

  describe('last-admin protection is isolated (dedicated app instance)', () => {
    let app: AppProcess;

    beforeAll(async () => {
      app = await spawnApp(oidcEnvFor(idp, { OIDC_ADMIN_GROUP: 'campfire-admins' }));
    });

    afterAll(async () => {
      await app.kill();
    });

    it('sole admin is never demoted even when the admin-group claim is dropped', async () => {
      idp.setNextUser({ sub: 'sub-only', preferred_username: 'onlyadmin', email: 'only@example.com', name: 'Only Admin', groups: ['campfire-admins'] });
      const agent = new CookieAgent(app.baseUrl);
      await performOidcLogin(agent);
      let me = await agent.get('/api/v1/me');
      let meBody = await me.json();
      expect(meBody.user.serverRole).toBe('admin');

      // Same sub, groups claim now empty -> would demote, but this is the only admin.
      idp.setNextUser({ sub: 'sub-only', preferred_username: 'onlyadmin', email: 'only@example.com', name: 'Only Admin', groups: [] });
      await performOidcLogin(agent);
      me = await agent.get('/api/v1/me');
      meBody = await me.json();
      expect(me.status).toBe(200);
      expect(meBody.user.serverRole).toBe('admin'); // refused demotion — last enabled admin
    });
  });

  // ── Issue #25: in-app OIDC config & connection test ──────────────────────
  // These boot the app with NO OIDC env vars, so OIDC is driven purely by the
  // in-app (settings-store) config an admin sets via the API. A local admin is
  // created via first-run setup to authenticate the admin-only settings routes.
  describe('in-app OIDC config (no env vars)', () => {
    const NO_OIDC_ENV: Record<string, string | undefined> = {
      OIDC_ISSUER: undefined,
      OIDC_CLIENT_ID: undefined,
      OIDC_CLIENT_SECRET: undefined,
      OIDC_REDIRECT_URI: undefined,
      OIDC_ADMIN_GROUP: undefined,
      OIDC_ALLOWED_GROUP: undefined,
      OIDC_GROUPS_CLAIM: undefined,
      OIDC_SCOPE: undefined,
    };

    /** Boots a fresh env-free app and creates the first (admin) user via first-run setup, returning an authenticated admin agent. */
    async function bootWithAdmin(): Promise<{ app: AppProcess; admin: CookieAgent }> {
      const app = await bootApp(NO_OIDC_ENV);
      const admin = new CookieAgent(app.baseUrl);
      const setupRes = await admin.postJson('/api/v1/auth/setup', {
        username: 'root',
        password: 'admin-pass-123',
        displayName: 'Root Admin',
      });
      expect(setupRes.status).toBe(201);
      return { app, admin };
    }

    it('GET /settings/oidc is admin-only (401 unauthenticated, 403 for a normal user, 200 for admin) and never returns the secret', async () => {
      const { app, admin } = await bootWithAdmin();

      const anon = await fetch(`${app.baseUrl}/api/v1/settings/oidc`);
      expect(anon.status).toBe(401);

      // Create a normal user and log them in locally.
      const created = await admin.postJson('/api/v1/users', {
        username: 'plain',
        password: 'user-pass-123',
        serverRole: 'user',
      });
      expect(created.status).toBe(201);
      const userAgent = new CookieAgent(app.baseUrl);
      const login = await userAgent.postJson('/api/v1/auth/login', { username: 'plain', password: 'user-pass-123' });
      expect(login.status).toBe(201);
      const denied = await userAgent.get('/api/v1/settings/oidc');
      expect(denied.status).toBe(403);

      const okRes = await admin.get('/api/v1/settings/oidc');
      expect(okRes.status).toBe(200);
      const body = await okRes.json();
      expect(body.enabled).toBe(false);
      expect(body.clientSecretSet).toBe(false);
      expect(body.envKeys).toEqual([]); // no OIDC_* env vars set
      expect(body).not.toHaveProperty('clientSecret');
    });

    it('persists config, keeps the client secret write-only, and flips AuthStatus.oidcEnabled', async () => {
      const { app, admin } = await bootWithAdmin();
      const redirectUri = `${app.baseUrl}/api/v1/auth/oidc/callback`;

      const patch = await admin.patchJson('/api/v1/settings/oidc', {
        issuer: idp.issuer,
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri,
        adminGroup: 'campfire-admins',
      });
      expect(patch.status).toBe(200);
      const patched = await patch.json();
      expect(patched.enabled).toBe(true);
      expect(patched.clientSecretSet).toBe(true);
      expect(patched.issuer).toBe(idp.issuer);
      expect(patched.adminGroup).toBe('campfire-admins');
      expect(patched).not.toHaveProperty('clientSecret');

      // GET reflects persistence, still no secret.
      const got = await (await admin.get('/api/v1/settings/oidc')).json();
      expect(got.clientId).toBe('test-client');
      expect(got.clientSecretSet).toBe(true);
      expect(got).not.toHaveProperty('clientSecret');

      // AuthStatus now advertises OIDC — driven by stored config, not env vars.
      const status = await (await fetch(`${app.baseUrl}/api/v1/auth/status`)).json();
      expect(status.oidcEnabled).toBe(true);

      // Omitting clientSecret keeps the stored secret (write-only semantics).
      const patch2 = await admin.patchJson('/api/v1/settings/oidc', { scope: 'openid profile email groups' });
      const p2 = await patch2.json();
      expect(p2.clientSecretSet).toBe(true);
      expect(p2.enabled).toBe(true);
      expect(p2.scope).toBe('openid profile email groups');

      // Explicitly clearing the secret ('') disables OIDC.
      const patch3 = await admin.patchJson('/api/v1/settings/oidc', { clientSecret: '' });
      const p3 = await patch3.json();
      expect(p3.clientSecretSet).toBe(false);
      expect(p3.enabled).toBe(false);
    });

    it('test-connection reports ok against a real discovery endpoint and error against an unreachable issuer', async () => {
      const { admin } = await bootWithAdmin();

      const okRes = await admin.postJson('/api/v1/settings/oidc/test', { issuer: idp.issuer });
      expect(okRes.status).toBe(200); // probe returns 200, not the default POST 201
      const okBody = await okRes.json();
      expect(okBody.ok).toBe(true);
      expect(okBody.authorizationEndpoint).toBe(`${idp.issuer}/authorize`);
      expect(okBody.tokenEndpoint).toBe(`${idp.issuer}/token`);

      const badRes = await admin.postJson('/api/v1/settings/oidc/test', { issuer: 'http://127.0.0.1:1/nope' });
      expect(badRes.status).toBe(200);
      const badBody = await badRes.json();
      expect(badBody.ok).toBe(false);
    });

    it('drives a full OIDC login round trip from in-app config alone (no env vars)', async () => {
      const { app, admin } = await bootWithAdmin();
      const redirectUri = `${app.baseUrl}/api/v1/auth/oidc/callback`;
      await admin.patchJson('/api/v1/settings/oidc', {
        issuer: idp.issuer,
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri,
        adminGroup: 'campfire-admins',
      });

      idp.setNextUser({ sub: 'sub-inapp', preferred_username: 'inapp', email: 'inapp@example.com', name: 'In App' });
      const agent = new CookieAgent(app.baseUrl);
      const cb = await performOidcLogin(agent);
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location')).toBe('/');

      const me = await (await agent.get('/api/v1/me')).json();
      expect(me.user.username).toBe('inapp');
    });

    it('allowed-group set via in-app config gates sign-in (deny without the group, allow with it)', async () => {
      const { app, admin } = await bootWithAdmin();
      const redirectUri = `${app.baseUrl}/api/v1/auth/oidc/callback`;
      await admin.patchJson('/api/v1/settings/oidc', {
        issuer: idp.issuer,
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri,
        adminGroup: 'campfire-admins',
        allowedGroup: 'campfire-users',
      });

      // No allowed-group membership -> denied at the callback with a 403, no session.
      idp.setNextUser({ sub: 'sub-nogroup', preferred_username: 'nogroup', email: 'n@example.com', name: 'No Group', groups: [] });
      const denied = await performOidcLogin(new CookieAgent(app.baseUrl));
      expect(denied.status).toBe(403);

      // Member of the allowed group -> provisioned normally.
      idp.setNextUser({ sub: 'sub-ingroup', preferred_username: 'ingroup', email: 'i@example.com', name: 'In Group', groups: ['campfire-users'] });
      const okAgent = new CookieAgent(app.baseUrl);
      const okCb = await performOidcLogin(okAgent);
      expect(okCb.status).toBe(302);
      const me = await (await okAgent.get('/api/v1/me')).json();
      expect(me.user.username).toBe('ingroup');
    });
  });
});
