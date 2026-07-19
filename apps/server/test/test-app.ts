import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

export interface TestAppContext {
  app: INestApplication;
  dataDir: string;
}

/**
 * Spins up a full Nest app against a unique temp SQLite dir per suite.
 * DATA_DIR must be set before the DbModule provider factory runs (module init).
 */
export async function createTestApp(): Promise<TestAppContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'api/docs', 'api/docs-json', 'api/openapi.json'],
  });
  await app.init();

  return { app, dataDir };
}

export async function closeTestApp(ctx: TestAppContext): Promise<void> {
  await ctx.app.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}
