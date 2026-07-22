import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp, setupApiDocs, resolveDocsEnabled } from '../src/main';

/**
 * Issue #46 (security): Swagger UI + OpenAPI JSON must not be public in production.
 * The registration lives in main.ts's setupApiDocs(), gated by resolveDocsEnabled()
 * (API_DOCS env override; else enabled outside production, disabled in production).
 * Like main-hardening.e2e-spec.ts, this suite builds the app the same way
 * test/test-app.ts does but applies main.ts's exported configureApp() + setupApiDocs()
 * on top, to exercise the real registration (and its gating) end-to-end.
 */
async function buildAppWithDocs(): Promise<{ app: INestApplication; dataDir: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  setupApiDocs(app);
  await app.init();

  return { app, dataDir };
}

describe('api docs exposure: enabled outside production by default (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    delete process.env.API_DOCS;
    const built = await buildAppWithDocs();
    app = built.app;
    dataDir = built.dataDir;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /api/docs serves the Swagger UI with no auth', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('swagger');
  });

  it('GET /api/openapi.json serves the OpenAPI document with no auth', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toEqual(expect.any(String));
    expect(res.body.info?.title).toBe('Campfire API');
  });

  it('documents exact XP recipients and the explicit non-active opt-in (issue #814)', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    const operation = res.body.paths?.['/api/v1/campaigns/{campaignId}/characters/xp']?.post;
    expect(operation?.description).toContain('active characters only');

    const requestSchema = operation?.requestBody?.content?.['application/json']?.schema as { $ref?: string } | undefined;
    const schemaName = requestSchema?.$ref?.split('/').pop();
    expect(schemaName).toBeTruthy();
    const properties = res.body.components?.schemas?.[schemaName!]?.properties;
    expect(properties).toHaveProperty('characterIds');
    expect(properties?.includeNonActive).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('documents membership integrity diagnostics and recovery (#849)', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    const diagnostics = res.body.paths?.['/api/v1/admin/membership-integrity']?.get;
    const recovery = res.body.paths?.['/api/v1/admin/membership-integrity/repair-dm']?.post;
    expect(diagnostics?.description).toContain('No campaign content or DM-secret fields');
    expect(recovery?.responses).toEqual(expect.objectContaining({ '201': expect.any(Object), '409': expect.any(Object) }));

    const requestSchema = recovery?.requestBody?.content?.['application/json']?.schema as { $ref?: string } | undefined;
    const schemaName = requestSchema?.$ref?.split('/').pop();
    expect(res.body.components?.schemas?.[schemaName!]?.properties).toEqual(
      expect.objectContaining({ campaignId: expect.any(Object), userId: expect.any(Object) }),
    );
  });

  it('documents the strict write-only AI provider draft test contract (issue #852)', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    for (const path of [
      '/api/v1/settings/ai-provider/test',
      '/api/v1/campaigns/{id}/ai-provider/test',
    ]) {
      const operation = res.body.paths?.[path]?.post;
      const requestSchema = operation?.requestBody?.content?.['application/json']?.schema;
      expect(requestSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['providerType', 'model']),
      });
      expect(requestSchema.properties).toEqual(expect.objectContaining({
        providerType: expect.any(Object),
        model: expect.objectContaining({ type: 'string', minLength: 1, maxLength: 120 }),
        baseUrl: expect.any(Object),
        apiKey: expect.objectContaining({ type: 'string', maxLength: 4096, writeOnly: true }),
      }));

      const responseRef = operation?.responses?.['201']?.content?.['application/json']?.schema?.$ref as string | undefined;
      const responseName = responseRef?.split('/').pop();
      expect(responseName).toBeTruthy();
      const responseProperties = res.body.components?.schemas?.[responseName!]?.properties;
      expect(responseProperties).toEqual(expect.objectContaining({
        ok: expect.any(Object),
        scope: expect.any(Object),
        testedTarget: expect.any(Object),
        providerType: expect.any(Object),
        model: expect.any(Object),
        baseUrl: expect.any(Object),
        credentialSource: expect.any(Object),
        testedAt: expect.any(Object),
        error: expect.any(Object),
      }));
      expect(responseProperties).not.toHaveProperty('apiKey');
    }
  });
});

describe('api docs exposure: API_DOCS=0 disables the docs (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  const originalApiDocs = process.env.API_DOCS;

  beforeAll(async () => {
    process.env.API_DOCS = '0';
    const built = await buildAppWithDocs();
    app = built.app;
    dataDir = built.dataDir;
  });

  afterAll(async () => {
    if (originalApiDocs === undefined) delete process.env.API_DOCS;
    else process.env.API_DOCS = originalApiDocs;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /api/docs -> 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs');
    expect(res.status).toBe(404);
  });

  it('GET /api/openapi.json -> 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    expect(res.status).toBe(404);
  });

  it('the rest of the API is unaffected (healthz still 200)', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
  });
});

describe('api docs exposure: resolveDocsEnabled() env matrix (unit)', () => {
  const originalApiDocs = process.env.API_DOCS;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalApiDocs === undefined) delete process.env.API_DOCS;
    else process.env.API_DOCS = originalApiDocs;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('enabled outside production when API_DOCS is unset', () => {
    delete process.env.API_DOCS;
    process.env.NODE_ENV = 'development';
    expect(resolveDocsEnabled()).toBe(true);
  });

  it('disabled in production when API_DOCS is unset (the issue #46 fix)', () => {
    delete process.env.API_DOCS;
    process.env.NODE_ENV = 'production';
    expect(resolveDocsEnabled()).toBe(false);
  });

  it('API_DOCS=1 force-enables, even in production', () => {
    process.env.API_DOCS = '1';
    process.env.NODE_ENV = 'production';
    expect(resolveDocsEnabled()).toBe(true);
  });

  it('API_DOCS=true (case-insensitive, trimmed) also enables', () => {
    process.env.API_DOCS = ' TRUE ';
    process.env.NODE_ENV = 'production';
    expect(resolveDocsEnabled()).toBe(true);
  });

  it('API_DOCS=0 force-disables, even outside production', () => {
    process.env.API_DOCS = '0';
    process.env.NODE_ENV = 'development';
    expect(resolveDocsEnabled()).toBe(false);
  });

  it('API_DOCS=false also disables', () => {
    process.env.API_DOCS = 'false';
    process.env.NODE_ENV = 'development';
    expect(resolveDocsEnabled()).toBe(false);
  });

  it('an unrecognized API_DOCS value falls back to the NODE_ENV default', () => {
    process.env.API_DOCS = 'banana';
    process.env.NODE_ENV = 'production';
    expect(resolveDocsEnabled()).toBe(false);
    process.env.NODE_ENV = 'development';
    expect(resolveDocsEnabled()).toBe(true);
  });
});
