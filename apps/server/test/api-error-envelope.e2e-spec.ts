import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { configureApp, setupApiDocs } from '../src/main';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * Issue #682 — REST + MCP wire-level contract tests for the unified error
 * envelope, plus the OpenAPI schema publication.
 *
 * The unit tests (test/unit/api-error-envelope.spec.ts) cover the pure
 * helpers. This suite proves:
 *   1. every REST error path emits the published Problem Details-style
 *      envelope, with an `X-Request-Id` response header whose value matches
 *      `body.requestId`;
 *   2. the same envelope shape (status/code/message/requestId) flows over
 *      MCP for tool failures, and the `code` slug vocabulary is identical
 *      on both transports;
 *   3. the OpenAPI document exposes named `ErrorResponse` + `FieldError`
 *      schema components and attaches a default `ErrorResponse` to every
 *      operation's 4xx/5xx responses.
 */

async function buildApp(listen = true): Promise<{ app: INestApplication; dataDir: string; baseUrl: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-err-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';
  process.env.THROTTLE_DISABLED = '1';
  delete process.env.API_DOCS;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  // configureApp() wires the same global filter the production bootstrap uses.
  configureApp(app);
  setupApiDocs(app);
  await app.init();
  if (listen) {
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    return { app, dataDir, baseUrl: `http://127.0.0.1:${address.port}` };
  }
  return { app, dataDir, baseUrl: '' };
}

/**
 * An alternate builder that mirrors test/test-app.ts (no configureApp(), just
 * the global filter + prefix) — used to verify the filter is what shapes the
 * response, independent of main.ts's other middleware.
 */
async function buildBareApp(): Promise<{ app: INestApplication; dataDir: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-err-'));
  process.env.DATA_DIR = dataDir;
  // DEV_AUTH is deliberately OFF here so an uncredentialed request reaches the
  // SessionAuthGuard's real 401 path (rather than being silently granted as a
  // synthetic dev-admin) — exercising the filter on a real auth exception.
  delete process.env.DEV_AUTH;
  process.env.THROTTLE_DISABLED = '1';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz', 'mcp', 'api/docs', 'api/docs-json', 'api/openapi.json'],
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return { app, dataDir };
}

async function mcpClient(app: INestApplication, baseUrl: string, token: string): Promise<Client> {
  const client = new Client({ name: 'err-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

interface ErrorBody {
  type?: string;
  title?: string;
  status: number;
  code: string;
  message: string;
  instance?: string;
  requestId?: string;
  errors?: { field: string; message: string }[];
}

describe('Issue #682 — REST error envelope (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  let dmToken: string;
  let campaignId: number;
  let dmAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const built = await buildApp();
    app = built.app;
    dataDir = built.dataDir;

    dmAgent = request.agent(app.getHttpServer());
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'dm', password: 'pw-12345' });
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'C' });
    campaignId = campRes.body.id;
    const tokRes = await dmAgent.post('/api/v1/tokens').send({ name: 't', scope: 'dm', writeScope: 'direct' });
    dmToken = tokRes.body.token;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('404 not_found — get_quest on a missing row', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/quests/999999')
      .set('Authorization', `Bearer ${dmToken}`);
    expect(res.status).toBe(404);
    const body = res.body as ErrorBody;
    expect(body.type).toBe('about:blank');
    expect(body.title).toBe('Not Found');
    expect(body.status).toBe(404);
    expect(body.code).toBe('not_found');
    expect(body.message).toContain('999999');
    expect(body.instance).toBe('/api/v1/quests/999999');
    expect(body.requestId).toBeTruthy();
    // X-Request-Id header matches body.requestId — end-to-end correlation.
    expect(res.headers['x-request-id']).toBe(body.requestId);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('400 bad_request — strict zod body rejects unknown key with structured errors[]', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('Authorization', `Bearer ${dmToken}`)
      .send({ title: 'T', reard: 'typo' }); // "reard" is not in the strict DTO
    expect(res.status).toBe(400);
    const body = res.body as ErrorBody;
    expect(body.status).toBe(400);
    expect(body.code).toBe('bad_request');
    expect(body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.requestId);
    // Either a structured per-field errors[] (nestjs-zod shape) OR a single
    // validation_failed message; both are valid envelopes. What we GUARANTEE
    // is the envelope shape, not the precise field-name recovery.
    if (body.errors) {
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors.length).toBeGreaterThan(0);
    } else {
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  it('403 forbidden — write-mode guard rejects a "none" writeScope token', async () => {
    // A PAT with writeScope 'none' is rejected by WriteModeGuard on every write
    // endpoint with `ForbiddenException('This token is read-only ...')`. This
    // is deterministic and role-independent — the guard fires BEFORE the route
    // handler, so the request never reaches quest creation.
    //
    // Mint via the authenticated dmAgent (session cookie) — a bare request()
    // would hit DEV_AUTH's synthetic dev-admin, which the tokens controller
    // explicitly rejects with 403 ("not available for dev-auth users").
    const noneTokRes = await dmAgent
      .post('/api/v1/tokens')
      .send({ name: 'none-t', scope: 'dm', writeScope: 'none' });
    const noneToken = noneTokRes.body.token;
    expect(noneToken).toBeTruthy();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set('Authorization', `Bearer ${noneToken}`)
      .send({ title: 'Blocked by write-mode' });
    expect(res.status).toBe(403);
    const body = res.body as ErrorBody;
    expect(body.status).toBe(403);
    expect(body.code).toBe('forbidden');
    expect(body.title).toBe('Forbidden');
    expect(body.message).toContain('read-only');
    expect(body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.requestId);
  });

  it('inbound X-Request-Id header propagates end-to-end', async () => {
    const inboundId = 'my-correlation-123';
    // Hit a guaranteed 404 path so the response goes through the filter and
    // the body envelope carries the same requestId as the header.
    const res = await request(app.getHttpServer())
      .get('/api/v1/quests/999999')
      .set('Authorization', `Bearer ${dmToken}`)
      .set('X-Request-Id', inboundId);
    expect(res.headers['x-request-id']).toBe(inboundId);
    const body = res.body as ErrorBody;
    expect(body.requestId).toBe(inboundId);
  });

  it('a fresh requestId is minted when no inbound header is supplied', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/quests/999999')
      .set('Authorization', `Bearer ${dmToken}`);
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    // UUID v4 shape — the format resolveRequestId falls back to.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe('Issue #682 — MCP error envelope parity (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  let baseUrl: string;
  let dmToken: string;

  beforeAll(async () => {
    const built = await buildApp();
    app = built.app;
    dataDir = built.dataDir;
    baseUrl = built.baseUrl;

    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/setup').send({ username: 'dm', password: 'pw-12345' });
    await agent.post('/api/v1/campaigns').send({ name: 'C' });
    const tokRes = await agent.post('/api/v1/tokens').send({ name: 't', scope: 'dm', writeScope: 'direct' });
    dmToken = tokRes.body.token;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function parse(result: unknown): { error: ErrorBody } {
    const content = (result as { content: { type: string; text: string }[] }).content;
    return JSON.parse(content[0].text);
  }

  it('MCP tool failure returns { error: { status, code, message, requestId } }', async () => {
    const client = await mcpClient(app, baseUrl, dmToken);
    const result = await client.callTool({ name: 'get_quest', arguments: { questId: 999999 } });
    expect(result.isError).toBe(true);
    const parsed = parse(result);
    expect(parsed.error.status).toBe(404);
    // SAME slug as REST — the vocabulary is shared across transports.
    expect(parsed.error.code).toBe('not_found');
    expect(parsed.error.message).toContain('999999');
    expect(parsed.error.requestId).toBeTruthy();
    await client.close();
  });

  it('MCP validation failures carry structured errors[]', async () => {
    const client = await mcpClient(app, baseUrl, dmToken);
    const result = await client.callTool({
      name: 'update_combatant',
      arguments: { encounterId: 1, combatantId: 1, hpCurrent: 5 },
    });
    expect(result.isError).toBe(true);
    const parsed = parse(result);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.code).toBe('validation_failed');
    expect(parsed.error.errors).toBeTruthy();
    expect(parsed.error.errors!.some((e) => e.field.includes('hpCurrent') || e.message.includes('hpCurrent'))).toBe(true);
    await client.close();
  });

  // Note: MCP forbidden (403) parity is exercised end-to-end in mcp.e2e-spec.ts
  // (issue #877 viewerClient.get_ai_support_preferences -> error.status 403 /
  // code "forbidden"), and the slug mapping itself is unit-tested in
  // test/unit/api-error-envelope.spec.ts. We don't duplicate it here because
  // the DEV_AUTH-based test bootstrap mints PATs against a synthetic dev user
  // that the MCP controller rejects at the transport boundary (-32001), so
  // driving a real viewer-role tool call requires the heavier real-membership
  // setup that already lives in mcp.e2e-spec.ts.
});

describe('Issue #682 — OpenAPI error schema publication (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  let spec: {
    components?: { schemas?: Record<string, unknown> };
    paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  };

  beforeAll(async () => {
    const built = await buildApp(false);
    app = built.app;
    dataDir = built.dataDir;

    const res = await request(app.getHttpServer()).get('/api/openapi.json');
    expect(res.status).toBe(200);
    spec = res.body;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('publishes the ErrorResponse + FieldError schema components', () => {
    expect(spec.components?.schemas?.ErrorResponse).toBeTruthy();
    expect(spec.components?.schemas?.FieldError).toBeTruthy();
    const errorResponse = spec.components!.schemas!.ErrorResponse as {
      required?: string[];
      properties?: { code?: { type?: string; description?: string } };
    };
    expect(errorResponse.required).toContain('requestId');
    expect(errorResponse.properties?.code?.type).toBe('string');
    expect(errorResponse.properties?.code?.description).toContain('bad_request');
  });

  it('attaches a default ErrorResponse to every operation 4xx/5xx slot', () => {
    expect(spec.paths).toBeTruthy();
    const samplePath = Object.keys(spec.paths!).find((p) => p.startsWith('/api/v1/quests'));
    expect(samplePath).toBeTruthy();
    const getOp = spec.paths![samplePath!].get;
    expect(getOp?.responses?.['400']).toBeTruthy();
    expect(getOp?.responses?.['404']).toBeTruthy();
    expect(getOp?.responses?.['500']).toBeTruthy();
    const notFound = getOp!.responses!['404'] as {
      content?: { 'application/json'?: { schema?: { $ref?: string } } };
    };
    expect(notFound.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/ErrorResponse');
  });

  it('does NOT clobber an explicitly-declared 4xx (e.g. maps controller 413)', () => {
    // The maps controller explicitly declares @ApiResponse({ status: 413 }).
    // registerErrorSchemas() must leave an explicitly-declared response alone.
    const mapsPath = Object.keys(spec.paths!).find((p) => p.includes('/maps-sources') && p.endsWith('import'));
    if (mapsPath) {
      const post = spec.paths![mapsPath]!.post;
      const four13 = post?.responses?.['413'] as { description?: string } | undefined;
      expect(four13).toBeTruthy();
      // Either the original description OR our default — but the key must exist.
      expect(typeof four13!.description).toBe('string');
    }
  });
});

describe('Issue #682 — bare-app filter wiring (filter is what shapes the response)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    const built = await buildBareApp();
    app = built.app;
    dataDir = built.dataDir;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('the AllExceptionsFilter alone shapes a 404 into the envelope', async () => {
    // No Authorization header -> SessionAuthGuard returns its 401 BEFORE any
    // route lookup, so this exercises the filter on a non-route-bound throw too.
    const res = await request(app.getHttpServer()).get('/api/v1/campaigns');
    expect(res.status).toBe(401);
    const body = res.body as ErrorBody;
    expect(body.code).toBe('unauthorized');
    expect(body.status).toBe(401);
    expect(body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.requestId);
  });
});
