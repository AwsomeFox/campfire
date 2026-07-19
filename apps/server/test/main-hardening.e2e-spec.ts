import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp, resolveCorsOrigin } from '../src/main';

/**
 * Punch list item 6 (prod hardening): helmet, an explicit express.json body-size limit,
 * and env-driven CORS origin resolution. These live in main.ts's bootstrap(), which
 * test/test-app.ts's createTestApp()/createTestAppNoDevAuth() deliberately don't call
 * (they build the Nest app directly via Test.createTestingModule + manual app.init(),
 * mirroring only cookie-parser + the global prefix — see test-app.ts's header comment).
 * So this suite builds an app the same way but applies main.ts's exported configureApp()
 * on top, to exercise the real hardening code path end-to-end.
 */
async function buildHardenedApp(): Promise<{ app: INestApplication; dataDir: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return { app, dataDir };
}

describe('main.ts hardening: helmet + body limit (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    const built = await buildHardenedApp();
    app = built.app;
    dataDir = built.dataDir;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('helmet headers are present on a normal response', async () => {
    const server = app.getHttpServer();
    const res = await request(server).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('a JSON body under 1mb is accepted', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'hardening-dm' })
      .send({ name: 'Small body campaign', description: 'x'.repeat(1000) });
    expect(res.status).toBe(201);
  });

  it('a JSON body over 1mb is rejected (413)', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'hardening-dm' })
      .send({ name: 'Big body campaign', description: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('multipart attachment upload (well under 1mb) still works — express.json limit does not affect multer', async () => {
    const server = app.getHttpServer();
    const campRes = await request(server)
      .post('/api/v1/campaigns')
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'hardening-dm' })
      .send({ name: 'Attachment hardening campaign' });
    const campaignId = campRes.body.id;

    const TINY_PNG = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
        '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
      'hex',
    );
    const uploadRes = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set({ 'x-dev-role': 'dm', 'x-dev-user': 'hardening-dm' })
      .field('kind', 'image')
      .attach('file', TINY_PNG, { filename: 'hardening.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
  });
});

describe('main.ts hardening: CORS origin resolution (unit, resolveCorsOrigin())', () => {
  const originalOrigin = process.env.ORIGIN;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.ORIGIN;
    else process.env.ORIGIN = originalOrigin;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('defaults to localhost:5173 outside production when ORIGIN is unset', () => {
    delete process.env.ORIGIN;
    process.env.NODE_ENV = 'development';
    expect(resolveCorsOrigin()).toEqual(['http://localhost:5173']);
  });

  it('ORIGIN env overrides the default, comma-split, even outside production', () => {
    process.env.ORIGIN = 'https://campfire.example.com, https://alt.example.com';
    process.env.NODE_ENV = 'development';
    expect(resolveCorsOrigin()).toEqual(['https://campfire.example.com', 'https://alt.example.com']);
  });

  it('production with ORIGIN set uses that origin', () => {
    process.env.ORIGIN = 'https://campfire.example.com';
    process.env.NODE_ENV = 'production';
    expect(resolveCorsOrigin()).toEqual(['https://campfire.example.com']);
  });

  it('production with no ORIGIN set disables CORS entirely (undefined)', () => {
    delete process.env.ORIGIN;
    process.env.NODE_ENV = 'production';
    expect(resolveCorsOrigin()).toBeUndefined();
  });
});
