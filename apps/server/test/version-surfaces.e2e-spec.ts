import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp, setupApiDocs } from '../src/main';
import { APP_VERSION } from '../src/common/build-metadata';

/**
 * Issue #432 — health, auth status, and OpenAPI must all report the same
 * package.json version (no more hard-coded 0.1.0 leftovers). MCP server-info
 * is kept on APP_VERSION by mcp-tools.ts + scripts/check-version-sync.mjs.
 */
describe('version surfaces (e2e, issue #432)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-version-'));
    process.env.DATA_DIR = dataDir;
    process.env.DEV_AUTH = '1';
    process.env.THROTTLE_DISABLED = '1';
    delete process.env.API_DOCS;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    setupApiDocs(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('healthz, auth/status, and OpenAPI agree on APP_VERSION', async () => {
    const health = await request(app.getHttpServer()).get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body.version).toBe(APP_VERSION);

    const ready = await request(app.getHttpServer()).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.version).toBe(APP_VERSION);

    const status = await request(app.getHttpServer()).get('/api/v1/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.version).toBe(APP_VERSION);

    const openapi = await request(app.getHttpServer()).get('/api/openapi.json');
    expect(openapi.status).toBe(200);
    expect(openapi.body.info?.version).toBe(APP_VERSION);
  });
});
