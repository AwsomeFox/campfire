import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
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
}

/**
 * Spins up a full Nest app against a unique temp SQLite dir per suite.
 * DATA_DIR must be set before the DbModule provider factory runs (module init).
 *
 * DEV_AUTH=1 keeps the legacy x-dev-role/x-dev-user header path alive for all
 * the pre-existing e2e suites; new auth-flow suites use a real cookie-session
 * supertest agent instead, which SessionAuthGuard prefers over headers.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';
  // Rate limiting (P2 fix) is opt-out for ordinary e2e suites — see throttle.constants.ts.
  // Suites that specifically exercise throttling (throttle.e2e-spec.ts) unset this themselves.
  process.env.THROTTLE_DISABLED = '1';
  // Fake in-process providers bind 127.0.0.1; opt into private hosts so existing
  // AI-provider suites keep working. SSRF suites (#1064) unset this themselves.
  process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = '1';

  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const { token, useValue } of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
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

  return { app, dataDir };
}

export async function closeTestApp(ctx: TestAppContext): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}

/** For the auth-flow suites that need DEV_AUTH unset (real cookie sessions only). */
export async function createTestAppNoDevAuth(): Promise<TestAppContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.DEV_AUTH;
  // Rate limiting (P2 fix) is opt-out for ordinary e2e suites — see throttle.constants.ts.
  // Suites that specifically exercise throttling (throttle.e2e-spec.ts) unset this themselves.
  process.env.THROTTLE_DISABLED = '1';
  process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = '1';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
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

  return { app, dataDir };
}
