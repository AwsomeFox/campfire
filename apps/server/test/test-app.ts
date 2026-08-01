import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { requestContextMiddleware } from '../src/common/request-context.middleware';
import { normalizeMissingBody } from '../src/common/normalize-body.middleware';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from '../src/app.module';

export interface TestAppContext {
  app: INestApplication;
  dataDir: string;
}

/**
 * A single provider binding to swap in the AppModule before the app boots.
 * Used by the AI eval harness (#318) to override AI_DM_PROVIDER with a
 * deterministic mock-backed provider so AI flows are testable offline. Kept
 * generic so any suite can inject a deterministic double for an injectable.
 */
export interface TestAppOverride {
  /** The DI token (class or symbol) to override. */
  token: Parameters<ReturnType<typeof Test.createTestingModule>['overrideProvider']>[0];
  /** The value to bind in its place. */
  useValue: unknown;
}

export interface CreateTestAppOptions {
  /** Provider bindings to override in the AppModule before it compiles. */
  overrides?: TestAppOverride[];
  /** Re-open an existing test data directory (used by interruption/recovery specs). */
  dataDir?: string;
  /**
   * Express middleware installed BEFORE `app.init()` — i.e. ahead of the Nest router.
   * Used by the mutation-idempotency fault-injection suite (#580) to simulate a response
   * that is lost, or replaced by a gateway error, AFTER the handler has already committed.
   * Must run before init to sit in front of the routes; adding it afterwards would append
   * it behind the router where it never executes.
   */
  middleware?: Array<(req: unknown, res: unknown, next: () => void) => void>;
}

/**
 * Spins up a full Nest app against a unique temp SQLite dir per suite.
 * DATA_DIR must be set before the DbModule provider factory runs (module init).
 *
 * DEV_AUTH=1 keeps the legacy x-dev-role/x-dev-user header path alive for all
 * the pre-existing e2e suites; new auth-flow suites use a real cookie-session
 * supertest agent instead, which SessionAuthGuard prefers over headers.
 *
 * Issue #580 — the app is created with `bodyParser: false` and its own `express.json()`,
 * mirroring main.ts's bootstrap. This is not cosmetic. `apps/server` resolves express 5,
 * whose body-parser is 2.x; Nest's DEFAULT parser resolves the hoisted body-parser 1.x.
 * The two disagree on exactly one thing that matters: for a request with no body, 1.x
 * coerces `req.body` to `{}` while 2.x leaves it `undefined`. A suite running on the
 * default parser therefore cannot see a body-less POST 400-ing against a DTO — which is
 * precisely the regression that reached CI on this issue's first run, invisible to a
 * green server suite. The harness must parse bodies the way production does.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppContext> {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';
  // Rate limiting (P2 fix) is opt-out for ordinary e2e suites — see throttle.constants.ts.
  // Suites that specifically exercise throttling (throttle.e2e-spec.ts) unset this themselves.
  process.env.THROTTLE_DISABLED = '1';
  // Fake in-process providers bind 127.0.0.1; opt into private hosts so existing
  // AI-provider suites keep working. SSRF suites (#1064) unset this themselves.
  process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = '1';
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  process.env.NO_PROXY = '*';
  process.env.no_proxy = '*';

  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const { token, useValue } of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.use(cookieParser());
  // Same parsers, same limits, same order as main.ts's configureApp().
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));
  app.use(normalizeMissingBody);
  for (const mw of options.middleware ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use(mw as any);
  }
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
  // Issue #682 / #684 — same request-context middleware as main.ts.
  app.use(requestContextMiddleware);
  // Mirror main.ts configureApp() — same global exception filter so every e2e
  // suite sees the published Problem Details-style envelope on the wire (issue #682).
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  return { app, dataDir };
}

export async function closeTestApp(ctx: TestAppContext): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}

/**
 * For the auth-flow suites that need DEV_AUTH unset (real cookie sessions / PATs only).
 * Accepts the same `overrides` seam as createTestApp so a suite driving real MCP/PAT auth
 * can still swap in a deterministic double (e.g. the inbox-sweep classifier, issue #1645).
 */
export async function createTestAppNoDevAuth(
  options: Pick<CreateTestAppOptions, 'overrides'> = {},
): Promise<TestAppContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.DEV_AUTH;
  // Rate limiting (P2 fix) is opt-out for ordinary e2e suites — see throttle.constants.ts.
  // Suites that specifically exercise throttling (throttle.e2e-spec.ts) unset this themselves.
  process.env.THROTTLE_DISABLED = '1';
  process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = '1';

  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const { token, useValue } of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.use(cookieParser());
  // Mirror main.ts (see createTestApp's note on the body-parser 1.x/2.x divergence).
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));
  app.use(normalizeMissingBody);
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
  // Issue #682 / #684 — same request-context middleware as main.ts.
  app.use(requestContextMiddleware);
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  return { app, dataDir };
}
