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
 * Spins up a full Nest app against a unique temp SQLite dir per suite.
 * DATA_DIR must be set before the DbModule provider factory runs (module init).
 *
 * DEV_AUTH=1 keeps the legacy x-dev-role/x-dev-user header path alive for all
 * the pre-existing e2e suites; new auth-flow suites use a real cookie-session
 * supertest agent instead, which SessionAuthGuard prefers over headers.
 */
export async function createTestApp(): Promise<TestAppContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';
  // Rate limiting (P2 fix) is opt-out for ordinary e2e suites — see throttle.constants.ts.
  // Suites that specifically exercise throttling (throttle.e2e-spec.ts) unset this themselves.
  process.env.THROTTLE_DISABLED = '1';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'mcp', 'api/docs', 'api/docs-json', 'api/openapi.json'],
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

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'mcp', 'api/docs', 'api/docs-json', 'api/openapi.json'],
  });
  await app.init();

  return { app, dataDir };
}
