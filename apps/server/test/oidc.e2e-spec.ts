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

  getCookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
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

async function startOidcLogin(agent: CookieAgent, redirect?: string): Promise<URL> {
  const path =
    redirect === undefined
      ? '/api/v1/auth/oidc/login'
      : `/api/v1/auth/oidc/login?redirect=${encodeURIComponent(redirect)}`;
  const loginRes = await agent.getNoRedirect(path);
  expect(loginRes.status).toBe(302);
  return new URL(loginRes.headers.get('location')!);
}

/** Drives the full /oidc/login -> fake IdP /authorize -> /oidc/callback round trip for a given cookie agent, returning the callback response (which sets the session cookie and redirects to the validated return path or '/'). */
async function performOidcLogin(agent: CookieAgent, redirect?: string): Promise<Response> {
  const authorizeUrl = await startOidcLogin(agent, redirect);

  // Simulate the browser following the redirect to the fake IdP, which immediately
  // redirects back to our callback URL (no real login form in the fake IdP).
  const idpRes = await fetchNoRedirect(authorizeUrl.toString());
  expect(idpRes.status).toBe(302);
  const callbackUrl = new URL(idpRes.headers.get('location')!);

  const callbackRes = await agent.getNoRedirect(callbackUrl.pathname + callbackUrl.search);
  return callbackRes;
}

const RECOVERY_CATEGORIES = [
  'cancelled',
  'flow_expired',
  'state_pkce_mismatch',
  'provider_unavailable',
  'client_token_failure',
  'missing_claims',
  'group_denied',
  'account_disabled',
] as const;
type RecoveryCategory = (typeof RECOVERY_CATEGORIES)[number];

function expectRecoveryRedirect(res: Response, category: RecoveryCategory): string {
  expect(res.status).toBe(302);
  const rawLocation = res.headers.get('location');
  expect(rawLocation).toBeTruthy();
  expect(rawLocation).toMatch(/^\/login\/sso-error\?/);
  const location = new URL(rawLocation!, 'http://campfire.invalid');
  expect(location.origin).toBe('http://campfire.invalid');
  expect(location.pathname).toBe('/login/sso-error');
  expect([...location.searchParams.keys()].sort()).toEqual(['category', 'ref']);
  expect(location.searchParams.get('category')).toBe(category);
  expect(RECOVERY_CATEGORIES).toContain(category);
  const reference = location.searchParams.get('ref');
  expect(reference).toMatch(/^[A-F0-9]{16}$/);
  expect(rawLocation).not.toContain('PROVIDER_PRIVATE');
  expect(rawLocation).not.toContain('test-secret');
  expect(rawLocation).not.toContain('sensitive-code');
  expect(rawLocation).not.toContain('sensitive-state');
  return reference!;
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
      expect(body.oidcProviderName).toBeNull();
    });

    it('uses neutral provider branding when the core OIDC config has no display name', async () => {
      const app = await bootApp(oidcEnvFor(idp, { OIDC_PROVIDER_NAME: undefined }));
      const res = await fetch(`${app.baseUrl}/api/v1/auth/status`);
      const body = await res.json();
      expect(body.oidcEnabled).toBe(true);
      expect(body.oidcProviderName).toBeNull();
      expect(Object.keys(body).sort()).toEqual([
        'localLoginEnabled',
        'oidcEnabled',
        'oidcProviderName',
        'setupRequired',
        'signupEnabled',
        'version',
      ]);
    });

    it('exposes only a configured provider display name, not admin/allowlist groups or OIDC secrets', async () => {
      const app = await bootApp(oidcEnvFor(idp, {
        OIDC_PROVIDER_NAME: 'Keycloak',
        OIDC_ADMIN_GROUP: 'secret-admin-group',
        OIDC_ALLOWED_GROUP: 'secret-allowlist-group',
      }));
      const res = await fetch(`${app.baseUrl}/api/v1/auth/status`);
      const body = await res.json();
      const serialized = JSON.stringify(body);

      expect(body.oidcEnabled).toBe(true);
      expect(body.oidcProviderName).toBe('Keycloak');
      expect(serialized).not.toContain(idp.issuer);
      expect(serialized).not.toContain('test-client');
      expect(serialized).not.toContain('test-secret');
      expect(serialized).not.toContain('secret-admin-group');
      expect(serialized).not.toContain('secret-allowlist-group');
      expect(Object.keys(body).sort()).toEqual([
        'localLoginEnabled',
        'oidcEnabled',
        'oidcProviderName',
        'setupRequired',
        'signupEnabled',
        'version',
      ]);
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
      expect(body.oidcProviderName).toBeNull();
    });
  });

  describe('/auth/oidc/login and /auth/oidc/callback disabled state', () => {
    it('login redirects to safe recovery when OIDC is not configured', async () => {
      const app = await bootApp({
        OIDC_ISSUER: undefined,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
        OIDC_REDIRECT_URI: undefined,
      });
      const res = await fetch(`${app.baseUrl}/api/v1/auth/oidc/login`, { redirect: 'manual' });
      expectRecoveryRedirect(res, 'provider_unavailable');
    });
  });

  describe('safe browser recovery redirects', () => {
    let app: AppProcess;

    beforeAll(async () => {
      app = await spawnApp(oidcEnvFor(idp, {
        OIDC_ALLOWED_GROUP: 'campfire-users',
        OIDC_ADMIN_GROUP: 'campfire-admins',
      }));
    });

    afterAll(async () => {
      await app.kill();
    });

    it('maps provider cancellation, logs only a redacted reference, and starts a fresh retry flow', async () => {
      idp.setNextMode('cancel');
      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      const reference = expectRecoveryRedirect(callbackRes, 'cancelled');

      expect(app.output()).toContain(`OIDC_RECOVERY reference=${reference} stage=callback category=cancelled`);
      expect(app.output()).not.toContain('PROVIDER_PRIVATE_CANCELLATION_DETAIL');
      expect(app.output()).not.toContain('test-secret');

      const firstRetry = await startOidcLogin(agent);
      const firstFlow = agent.getCookie('campfire_oidc_flow');
      const secondRetry = await startOidcLogin(agent);
      const secondFlow = agent.getCookie('campfire_oidc_flow');
      expect(firstRetry.pathname).toBe('/authorize');
      expect(secondRetry.pathname).toBe('/authorize');
      expect(firstFlow).toBeTruthy();
      expect(secondFlow).toBeTruthy();
      expect(secondFlow).not.toBe(firstFlow);
    });

    it('maps an expired or missing flow before using callback payloads', async () => {
      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await agent.getNoRedirect(
        '/api/v1/auth/oidc/callback?code=sensitive-code&state=sensitive-state',
      );
      expectRecoveryRedirect(callbackRes, 'flow_expired');
    });

    it('maps a state mismatch without contacting the token endpoint', async () => {
      const agent = new CookieAgent(app.baseUrl);
      await startOidcLogin(agent);
      const callbackRes = await agent.getNoRedirect(
        '/api/v1/auth/oidc/callback?code=sensitive-code&state=sensitive-state',
      );
      expectRecoveryRedirect(callbackRes, 'state_pkce_mismatch');
    });

    it('maps a PKCE verifier mismatch returned as invalid_grant', async () => {
      const agent = new CookieAgent(app.baseUrl);
      const authorizeUrl = await startOidcLogin(agent);
      const idpRes = await fetchNoRedirect(authorizeUrl.toString());
      const callbackUrl = new URL(idpRes.headers.get('location')!);
      const flow = agent.getCookie('campfire_oidc_flow');
      expect(flow).toBeTruthy();
      const [state] = decodeURIComponent(flow!).split(':');
      agent.setCookie(
        'campfire_oidc_flow',
        encodeURIComponent(`${state}:tampered-pkce-verifier`),
      );

      const callbackRes = await agent.getNoRedirect(callbackUrl.pathname + callbackUrl.search);
      expectRecoveryRedirect(callbackRes, 'state_pkce_mismatch');
      expect(app.output()).not.toContain('PROVIDER_PRIVATE_PKCE_DETAIL');
    });

    it('maps client/token endpoint rejection without exposing the provider response', async () => {
      idp.setNextMode('token_error');
      const callbackRes = await performOidcLogin(new CookieAgent(app.baseUrl));
      expectRecoveryRedirect(callbackRes, 'client_token_failure');
      expect(app.output()).not.toContain('PROVIDER_PRIVATE_TOKEN_DETAIL');
    });

    it('maps a successful token response with no ID-token claims', async () => {
      idp.setNextMode('missing_claims');
      const callbackRes = await performOidcLogin(new CookieAgent(app.baseUrl));
      expectRecoveryRedirect(callbackRes, 'missing_claims');
    });

    it('maps allowed-group denial and does not create a session', async () => {
      idp.setNextUser({
        sub: 'sub-recovery-outsider',
        preferred_username: 'recovery-outsider',
        groups: ['another-app'],
      });
      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expectRecoveryRedirect(callbackRes, 'group_denied');
      expect((await agent.get('/api/v1/me')).status).toBe(401);
    });

    it('preserves the successful callback contract and session semantics', async () => {
      idp.setNextUser({
        sub: 'sub-recovery-success',
        preferred_username: 'recovery-success',
        groups: ['campfire-users'],
      });
      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/');
      expect((await agent.get('/api/v1/me')).status).toBe(200);
    });

    it('returns to a validated ?redirect= path after SSO (issue #478)', async () => {
      idp.setNextUser({
        sub: 'sub-recovery-return',
        preferred_username: 'recovery-return',
        groups: ['campfire-users'],
      });
      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent, '/join/INVITE478');
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/join/INVITE478');
      expect((await agent.get('/api/v1/me')).status).toBe(200);
    });

    it('rejects open-redirect targets and falls back to / (issue #478)', async () => {
      idp.setNextUser({
        sub: 'sub-recovery-openredir',
        preferred_username: 'recovery-openredir',
        groups: ['campfire-users'],
      });
      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent, 'https://evil.example/phish');
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/');
    });
  });

  it('maps an unreachable discovery endpoint to provider unavailable recovery', async () => {
    const unreachablePort = await getFreePort();
    const app = await bootApp((port) => ({
      OIDC_ISSUER: `http://127.0.0.1:${unreachablePort}`,
      OIDC_CLIENT_ID: 'test-client',
      OIDC_CLIENT_SECRET: 'test-secret',
      OIDC_REDIRECT_URI: `http://127.0.0.1:${port}/api/v1/auth/oidc/callback`,
      OIDC_ALLOW_INSECURE: '1',
    }));
    const res = await fetch(`${app.baseUrl}/api/v1/auth/oidc/login`, { redirect: 'manual' });
    expectRecoveryRedirect(res, 'provider_unavailable');
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

    it('local login attempt on an SSO-provisioned (passwordless) user returns the generic 401, not an SSO-revealing 403 (issue #89)', async () => {
      // Previously this returned 403 "This account uses SSO", which let an
      // unauthenticated caller enumerate which usernames are SSO-only (and it
      // fired before any scrypt work, so timing confirmed existence too). It now
      // collapses to the same generic 401 as an unknown user / wrong password.
      const res = await fetch(`${app.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'whatever' }),
      });
      const body = await res.json();
      expect(res.status).toBe(401);
      expect(body.message).toBe('Invalid username or password');
      expect(JSON.stringify(body)).not.toMatch(/SSO/i);
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

    it('disabled OIDC user reaches safe account-disabled recovery and gets no session cookie', async () => {
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
      expectRecoveryRedirect(callbackRes, 'account_disabled');

      // No session cookie (campfire_session) was issued to the disabled user — only the
      // OIDC flow cookie gets cleared (expected on every callback, success or failure).
      const headers = callbackRes.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
      expect(setCookies.some((c) => c.startsWith('campfire_session='))).toBe(false);

      const meAfterDenied = await retryAgent.get('/api/v1/me');
      expect(meAfterDenied.status).toBe(401);
    });
  });

  // Issue #45 fix pinning tests — with OIDC_ALLOWED_GROUP set, authenticating at the
  // IdP is no longer sufficient to get a Campfire account: the groups claim must
  // contain the allowed group (or the admin group — admins always retain access).
  // Before this fix, provisionOrUpdateUser created an account for ANY valid `sub`,
  // so on a shared corporate/family IdP everyone got a Campfire account on first login.
  describe('OIDC_ALLOWED_GROUP sign-in allowlist (dedicated app instance)', () => {
    let app: AppProcess;

    beforeAll(async () => {
      app = await spawnApp(oidcEnvFor(idp, { OIDC_ALLOWED_GROUP: 'campfire-users', OIDC_ADMIN_GROUP: 'campfire-admins' }));
    });

    afterAll(async () => {
      await app.kill();
    });

    it('denies a user without the allowed group: safe recovery, no session cookie, no account provisioned', async () => {
      idp.setNextUser({ sub: 'sub-outsider', preferred_username: 'outsider', email: 'outsider@example.com', name: 'Out Sider', groups: ['some-other-app'] });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expectRecoveryRedirect(callbackRes, 'group_denied');

      // No session cookie was minted — only the OIDC flow cookie gets cleared.
      const headers = callbackRes.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
      expect(setCookies.some((c) => c.startsWith('campfire_session='))).toBe(false);

      const meRes = await agent.get('/api/v1/me');
      expect(meRes.status).toBe(401);
    });

    it('no account row exists for the denied user (visible to an admin in the users list)', async () => {
      // Sign in as an admin (allowed via the admin group) and confirm the denied
      // sub was never provisioned — the allowlist gates provisioning itself, not
      // just the session.
      idp.setNextUser({ sub: 'sub-allow-admin', preferred_username: 'allowadmin', email: 'allowadmin@example.com', name: 'Allow Admin', groups: ['campfire-admins'] });
      const adminAgent = new CookieAgent(app.baseUrl);
      await performOidcLogin(adminAgent);
      const adminMe = await adminAgent.get('/api/v1/me');
      const adminMeBody = await adminMe.json();
      expect(adminMe.status).toBe(200);
      expect(adminMeBody.user.serverRole).toBe('admin');

      const usersRes = await adminAgent.get('/api/v1/users');
      expect(usersRes.status).toBe(200);
      const users = await usersRes.json();
      const usernames = (users as Array<{ username: string }>).map((u) => u.username);
      expect(usernames).not.toContain('outsider');
    });

    it('allows a user in the allowed group: provisions and signs in normally', async () => {
      idp.setNextUser({ sub: 'sub-member', preferred_username: 'member', email: 'member@example.com', name: 'Mem Ber', groups: ['campfire-users'] });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/');

      const meRes = await agent.get('/api/v1/me');
      const meBody = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meBody.user.username).toBe('member');
      expect(meBody.user.serverRole).toBe('user');
    });

    it('allows an admin-group member who is NOT in the allowed group (admin implies access)', async () => {
      idp.setNextUser({ sub: 'sub-admin-only', preferred_username: 'adminonly', email: 'adminonly@example.com', name: 'Admin Only', groups: ['campfire-admins'] });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expect(callbackRes.status).toBe(302);

      const meRes = await agent.get('/api/v1/me');
      const meBody = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meBody.user.serverRole).toBe('admin');
    });

    it('locks out an EXISTING user who is removed from the allowed group at the IdP', async () => {
      // member was provisioned above while in campfire-users; drop the group and retry.
      idp.setNextUser({ sub: 'sub-member', preferred_username: 'member', email: 'member@example.com', name: 'Mem Ber', groups: [] });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expectRecoveryRedirect(callbackRes, 'group_denied');

      const meRes = await agent.get('/api/v1/me');
      expect(meRes.status).toBe(401);
    });

    it('re-admits that user once the group is restored (same account, no duplicate)', async () => {
      idp.setNextUser({ sub: 'sub-member', preferred_username: 'member', email: 'member@example.com', name: 'Mem Ber', groups: ['campfire-users'] });

      const agent = new CookieAgent(app.baseUrl);
      const callbackRes = await performOidcLogin(agent);
      expect(callbackRes.status).toBe(302);

      const meRes = await agent.get('/api/v1/me');
      const meBody = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meBody.user.username).toBe('member'); // sub-based reuse — no `member-2`
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
      OIDC_PROVIDER_NAME: undefined,
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
      expect(body.providerName).toBe('');
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
        providerName: 'Keycloak',
        adminGroup: 'campfire-admins',
      });
      expect(patch.status).toBe(200);
      const patched = await patch.json();
      expect(patched.enabled).toBe(true);
      expect(patched.clientSecretSet).toBe(true);
      expect(patched.providerName).toBe('Keycloak');
      expect(patched.issuer).toBe(idp.issuer);
      expect(patched.adminGroup).toBe('campfire-admins');
      expect(patched).not.toHaveProperty('clientSecret');

      // GET reflects persistence, still no secret.
      const got = await (await admin.get('/api/v1/settings/oidc')).json();
      expect(got.clientId).toBe('test-client');
      expect(got.providerName).toBe('Keycloak');
      expect(got.clientSecretSet).toBe(true);
      expect(got).not.toHaveProperty('clientSecret');

      // AuthStatus now advertises OIDC — driven by stored config, not env vars.
      const status = await (await fetch(`${app.baseUrl}/api/v1/auth/status`)).json();
      expect(status.oidcEnabled).toBe(true);
      expect(status.oidcProviderName).toBe('Keycloak');
      expect(JSON.stringify(status)).not.toContain('test-secret');
      expect(JSON.stringify(status)).not.toContain('campfire-admins');

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

    it('test-connection reports Discovery reachable against a real discovery endpoint and error against an unreachable issuer', async () => {
      const { admin } = await bootWithAdmin();

      const okRes = await admin.postJson('/api/v1/settings/oidc/test', { issuer: idp.issuer });
      expect(okRes.status).toBe(200); // probe returns 200, not the default POST 201
      const okBody = await okRes.json();
      expect(okBody.ok).toBe(true);
      expect(okBody.kind).toBe('discovery');
      expect(okBody.message).toBe('Discovery reachable.');
      expect(okBody.checks.discovery.status).toBe('pass');
      expect(okBody.authorizationEndpoint).toBe(`${idp.issuer}/authorize`);
      expect(okBody.tokenEndpoint).toBe(`${idp.issuer}/token`);
      expect(okBody.fingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(okBody.testedAt).toBeTruthy();
      expect(JSON.stringify(okBody)).not.toContain('test-secret');

      const badRes = await admin.postJson('/api/v1/settings/oidc/test', { issuer: 'http://127.0.0.1:1/nope' });
      expect(badRes.status).toBe(200);
      const badBody = await badRes.json();
      expect(badBody.ok).toBe(false);
      expect(badBody.checks.discovery.status).toBe('fail');
    });

    it('diagnostics: mismatched issuer, bad client, bad redirect, timeout, overrides, claims/groups, and e2e success (issue #848)', async () => {
      const { app, admin } = await bootWithAdmin();
      const redirectUri = `${app.baseUrl}/api/v1/auth/oidc/callback`;

      // --- mismatched issuer ---
      idp.setDiscoveryIssuer('https://evil.example.com/issuer');
      const mismatch = await (
        await admin.postJson('/api/v1/settings/oidc/test', { issuer: idp.issuer })
      ).json();
      expect(mismatch.ok).toBe(false);
      expect(mismatch.checks.discovery.status).toBe('fail');
      expect(mismatch.message).toMatch(/Issuer mismatch/i);
      idp.setDiscoveryIssuer(null);

      // --- timeout ---
      idp.setDiscoveryDelayMs(6_000);
      const timed = await (
        await admin.postJson('/api/v1/settings/oidc/test', { issuer: idp.issuer })
      ).json();
      expect(timed.ok).toBe(false);
      expect(timed.checks.discovery.status).toBe('fail');
      expect(timed.message).toMatch(/timed out/i);
      idp.setDiscoveryDelayMs(0);

      // Persist a good config so stored/env source labels can be exercised.
      await admin.patchJson('/api/v1/settings/oidc', {
        issuer: idp.issuer,
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri,
        adminGroup: 'campfire-admins',
        allowedGroup: 'campfire-users',
      });

      // --- success discovery + client probe ---
      const okProbe = await (
        await admin.postJson('/api/v1/settings/oidc/test', {
          issuer: idp.issuer,
          clientId: 'test-client',
          redirectUri,
        })
      ).json();
      expect(okProbe.ok).toBe(true);
      expect(okProbe.message).toBe('Discovery reachable.');
      expect(okProbe.checks.discovery.status).toBe('pass');
      expect(okProbe.checks.redirectClient.status).toBe('pass');
      expect(okProbe.checks.tokenExchange.status).toBe('skip');
      expect(okProbe.fieldSources.issuer).toBe('draft');
      expect(okProbe.fieldSources.clientSecret).toBe('stored');
      expect(JSON.stringify(okProbe)).not.toContain('test-secret');

      // --- bad client secret ---
      const badClient = await (
        await admin.postJson('/api/v1/settings/oidc/test', {
          issuer: idp.issuer,
          clientId: 'test-client',
          clientSecret: 'wrong-secret',
          redirectUri,
        })
      ).json();
      expect(badClient.checks.discovery.status).toBe('pass');
      expect(badClient.checks.redirectClient.status).toBe('fail');
      expect(badClient.checks.redirectClient.message).toMatch(/client/i);

      // --- bad redirect ---
      idp.setAllowedRedirectUris([redirectUri]);
      const badRedirect = await (
        await admin.postJson('/api/v1/settings/oidc/test', {
          issuer: idp.issuer,
          clientId: 'test-client',
          clientSecret: 'test-secret',
          redirectUri: 'http://127.0.0.1:9/not-registered',
        })
      ).json();
      expect(badRedirect.checks.redirectClient.status).toBe('fail');
      idp.setAllowedRedirectUris(null);

      // --- environment override source labeling ---
      // Re-boot is expensive; instead assert stored source when no draft issuer is sent.
      const storedProbe = await (await admin.postJson('/api/v1/settings/oidc/test', {})).json();
      expect(storedProbe.fieldSources.issuer).toBe('stored');
      expect(storedProbe.fieldSources.clientId).toBe('stored');

      // Snapshot admin session before e2e diagnostic — must not be replaced.
      const meBefore = await (await admin.get('/api/v1/me')).json();
      expect(meBefore.user.username).toBe('root');
      const userCountBefore = (await (await admin.get('/api/v1/users')).json()).length;

      // --- e2e success (no session swap, no provisioning) ---
      idp.setNextUser({
        sub: 'diag-sub',
        preferred_username: 'diaguser',
        email: 'diag@example.com',
        name: 'Diag User',
        groups: ['campfire-users'],
      });
      const start = await admin.postJson('/api/v1/settings/oidc/test-login', {
        issuer: idp.issuer,
        clientId: 'test-client',
        redirectUri,
        allowedGroup: 'campfire-users',
      });
      expect(start.status).toBe(200);
      const startBody = await start.json();
      expect(startBody.authorizationUrl).toContain('/authorize');
      expect(startBody.fingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(startBody).not.toHaveProperty('flowToken');
      expect(JSON.stringify(startBody)).not.toContain('test-secret');

      const idpRes = await fetchNoRedirect(startBody.authorizationUrl);
      expect(idpRes.status).toBe(302);
      const callbackUrl = new URL(idpRes.headers.get('location')!);
      const cb = await admin.getNoRedirect(callbackUrl.pathname + callbackUrl.search);
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location')).toBe('/admin/auth?oidcDiag=1');

      const result = await (await admin.get('/api/v1/settings/oidc/test-login/result')).json();
      expect(result.kind).toBe('e2e');
      expect(result.ok).toBe(true);
      expect(result.checks.tokenExchange.status).toBe('pass');
      expect(result.checks.requiredClaims.status).toBe('pass');
      expect(result.checks.groupPolicy.status).toBe('pass');
      expect(JSON.stringify(result)).not.toContain('test-secret');

      const meAfter = await (await admin.get('/api/v1/me')).json();
      expect(meAfter.user.username).toBe('root');
      expect(meAfter.user.id).toBe(meBefore.user.id);
      const userCountAfter = (await (await admin.get('/api/v1/users')).json()).length;
      expect(userCountAfter).toBe(userCountBefore);

      const view = await (await admin.get('/api/v1/settings/oidc')).json();
      expect(view.lastE2eTest?.ok).toBe(true);
      expect(view.lastE2eTest?.fingerprint).toBe(view.configFingerprint);

      // --- e2e group policy failure (still no provision) ---
      idp.setNextUser({
        sub: 'diag-denied',
        preferred_username: 'denied',
        email: 'denied@example.com',
        name: 'Denied',
        groups: [],
      });
      const startDenied = await (
        await admin.postJson('/api/v1/settings/oidc/test-login', {
          issuer: idp.issuer,
          clientId: 'test-client',
          redirectUri,
          allowedGroup: 'campfire-users',
        })
      ).json();
      const idpDenied = await fetchNoRedirect(startDenied.authorizationUrl);
      const cbDeniedUrl = new URL(idpDenied.headers.get('location')!);
      await admin.getNoRedirect(cbDeniedUrl.pathname + cbDeniedUrl.search);
      const deniedResult = await (await admin.get('/api/v1/settings/oidc/test-login/result')).json();
      expect(deniedResult.ok).toBe(false);
      expect(deniedResult.checks.groupPolicy.status).toBe('fail');
      expect((await (await admin.get('/api/v1/users')).json()).length).toBe(userCountBefore);

      // --- e2e missing claims ---
      idp.setNextMode('missing_claims');
      const startMissing = await (
        await admin.postJson('/api/v1/settings/oidc/test-login', {
          issuer: idp.issuer,
          clientId: 'test-client',
          redirectUri,
        })
      ).json();
      const idpMissing = await fetchNoRedirect(startMissing.authorizationUrl);
      const cbMissingUrl = new URL(idpMissing.headers.get('location')!);
      await admin.getNoRedirect(cbMissingUrl.pathname + cbMissingUrl.search);
      const missingResult = await (await admin.get('/api/v1/settings/oidc/test-login/result')).json();
      expect(missingResult.ok).toBe(false);
      expect(
        missingResult.checks.requiredClaims.status === 'fail' ||
          missingResult.checks.tokenExchange.status === 'fail',
      ).toBe(true);
    });

    it('leftover diagnostic test cookie does not hijack a normal SSO callback (issue #848)', async () => {
      const { app, admin } = await bootWithAdmin();
      const redirectUri = `${app.baseUrl}/api/v1/auth/oidc/callback`;
      await admin.patchJson('/api/v1/settings/oidc', {
        issuer: idp.issuer,
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri,
      });

      // Start an admin diagnostic (sets campfire_oidc_test_flow) but do not complete it.
      const started = await (
        await admin.postJson('/api/v1/settings/oidc/test-login', {
          issuer: idp.issuer,
          clientId: 'test-client',
          redirectUri,
        })
      ).json();
      expect(started.authorizationUrl).toContain('/authorize');
      expect(admin.getCookie('campfire_oidc_test_flow')).toBeTruthy();

      // Normal SSO in the same browser jar must still create a session — the
      // leftover test cookie's pending state does not match this callback's state.
      idp.setNextUser({
        sub: 'sub-normal-sso',
        preferred_username: 'normalsso',
        email: 'normal@example.com',
        name: 'Normal SSO',
      });
      const cb = await performOidcLogin(admin);
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location')).toBe('/');
      expect(cb.headers.get('location')).not.toBe('/admin/auth?oidcDiag=1');

      const me = await (await admin.get('/api/v1/me')).json();
      expect(me.user.username).toBe('normalsso');
    });

    it('diagnostics label environment-overridden values without echoing secrets (issue #848)', async () => {
      const app = await bootApp(oidcEnvFor(idp));
      const admin = new CookieAgent(app.baseUrl);
      const setupRes = await admin.postJson('/api/v1/auth/setup', {
        username: 'root',
        password: 'admin-pass-123',
        displayName: 'Root Admin',
      });
      expect(setupRes.status).toBe(201);

      const probe = await (await admin.postJson('/api/v1/settings/oidc/test', {})).json();
      expect(probe.ok).toBe(true);
      expect(probe.message).toBe('Discovery reachable.');
      expect(probe.fieldSources.issuer).toBe('environment');
      expect(probe.fieldSources.clientId).toBe('environment');
      expect(probe.fieldSources.clientSecret).toBe('environment');
      expect(probe.checks.redirectClient.status).toBe('pass');
      expect(JSON.stringify(probe)).not.toContain('test-secret');

      const view = await (await admin.get('/api/v1/settings/oidc')).json();
      expect(view.envKeys).toEqual(
        expect.arrayContaining(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']),
      );
      expect(view.configFingerprint).toMatch(/^[a-f0-9]{16}$/);
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

      // No allowed-group membership -> safe recovery redirect, no session.
      idp.setNextUser({ sub: 'sub-nogroup', preferred_username: 'nogroup', email: 'n@example.com', name: 'No Group', groups: [] });
      const denied = await performOidcLogin(new CookieAgent(app.baseUrl));
      expectRecoveryRedirect(denied, 'group_denied');

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
