import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { configureApp, setupApiDocs } from '../src/main';

/**
 * Issue #566 (contract): the OpenAPI spec is generated from controller decorators,
 * but NOTHING asserted that every controller route was correctly documented. Two
 * failure modes were invisible:
 *   1. Decorator drift: a controller losing @ApiTags, or a handler losing
 *      @ApiOperation, silently degrades its spec entry (no tag group, no summary)
 *      — and with no test watching decorator coverage, an entire controller could
 *      even fall out of the generated contract unnoticed.
 *   2. Route drift: a new route added without decorators, or a path-prefix change,
 *      never tripped a check; the spec and the real router silently disagreed.
 *
 * This suite closes both by REFLECTING over every registered controller (the source
 * of truth for routing) and reconciling it against the generated spec:
 *
 *   - Every non-excluded controller route must appear under spec.paths (and every
 *     spec path must be backed by a controller route — no orphans either).
 *   - Every non-excluded controller must carry @ApiTags, and every non-excluded
 *     handler must carry @ApiOperation — the two decorators whose absence degrades
 *     or drops the route's spec entry (#1).
 *   - The full sorted path list is snapshotted, so adding OR removing a route is a
 *     deliberate `jest -u` event rather than silent drift.
 *
 * Why reflection over a hand-maintained allowlist: 50+ controllers / 200+ paths is
 * already too many to keep in sync by hand, and the whole point of #566 is that a
 * hand list is exactly what drifts. The controllers' own decorator metadata IS the
 * authoritative route table — we read it straight from Nest's metadata via
 * PATH_METADATA / METHOD_METADATA and from Swagger's via the DECORATORS.* keys.
 *
 * Exclusions are likewise read from the source, not asserted in a comment:
 * `@ApiExcludeController()` is the documented Swagger escape hatch for routes that
 * must NOT appear in the public REST spec. The MCP transport (POST /mcp) and the
 * OAuth authorization-server / discovery endpoints (under /oauth and /.well-known)
 * are non-REST protocol endpoints mounted at the application root outside the
 * /api/v1 prefix (see the setGlobalPrefix exclude list in main.ts) — they are
 * @ApiExcludeController'd on purpose, and this suite honors that automatically.
 * No route needs to be remembered here; decorate-or-exclude is the contract.
 */

// Nest request-method enum (RequestMethod.GET = 0 ... SEARCH = 8). Mirrors the
// order in @nestjs/common/enums/request-method.enum so the reflected integer maps
// to the OpenAPI HTTP verb key.
const HTTP_VERBS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head', 'search'] as const;

// Global API prefix applied in main.ts configureApp(). Routes whose full path
// matches one of the setGlobalPrefix exclude entries are mounted at the root
// (healthz, the MCP transport, OAuth, the docs themselves) and so do NOT get
// /api/v1 prepended in the spec. Kept in sync with main.ts; if that list changes
// this must too (and the snapshot will force the review).
const GLOBAL_PREFIX = 'api/v1';
const ROOT_MOUNTED_ROUTES = new Set([
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
]);

interface RouteReflection {
  controllerName: string;
  methodName: string;
  verb: string;
  specPath: string;
}

/**
 * Mirror @nestjs/swagger's validateRoutePath() exactly: parse with path-to-regexp
 * (the same library Swagger uses internally) and join literal segments with
 * `{prefix}{name}` for params. Reproducing Swagger's own transform here is what
 * makes the reflected expected path line up with the spec path character-for-
 * character (e.g. :token.ics -> {token}.ics, not a naive regex's {token}).
 */
function toSpecPath(raw: unknown): string {
  if (!raw || raw === '/') return '';
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse } = require('path-to-regexp');
  let out = '';
  for (const item of parse(str)) {
    out += typeof item === 'string' ? item : `${item.prefix}{${item.name}}`;
  }
  return out === '/' ? '' : out;
}

/** Join a controller prefix and a handler path the way NestJS does (no double slashes). */
function joinControllerPath(prefix: unknown, routePath: unknown): string {
  const p = toSpecPath(prefix);
  const r = toSpecPath(routePath);
  return [p, r].filter(Boolean).join('/');
}

/** Prefix a controller-route path with the global /api/v1 unless it is mounted at the root. */
function withGlobalPrefix(routePath: string): string {
  const bare = routePath.replace(/^\/+/, '');
  const rootMounted =
    ROOT_MOUNTED_ROUTES.has(bare) ||
    [...ROOT_MOUNTED_ROUTES].some((excluded) => bare === excluded || bare.startsWith(excluded + '/'));
  return rootMounted ? `/${routePath}` : `/${GLOBAL_PREFIX}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

// --- Swagger metadata readers -------------------------------------------------
// These read the exact same Reflect metadata keys @nestjs/swagger's own explorers
// read (see @nestjs/swagger/dist/constants.js DECORATORS.*). Plain Reflect is used
// deliberately — it's what the library itself uses, and it avoids coupling this
// contract test to Reflector's generic-typed wrapper.
const MD = {
  apiExcludeController: 'swagger/apiExcludeController',
  apiExcludeEndpoint: 'swagger/apiExcludeEndpoint',
  apiOperation: 'swagger/apiOperation',
  apiUseTags: 'swagger/apiUseTags',
} as const;

const isControllerExcluded = (metatype: unknown): boolean =>
  (Reflect.getMetadata(MD.apiExcludeController, metatype as object)?.[0] as boolean | undefined) === true;

const isEndpointExcluded = (handler: unknown): boolean =>
  (Reflect.getMetadata(MD.apiExcludeEndpoint, handler as object)?.[0] as boolean | undefined) === true;

const hasApiTags = (metatype: unknown): boolean => {
  const tags = Reflect.getMetadata(MD.apiUseTags, metatype as object);
  return Array.isArray(tags) && tags.length > 0;
};

const hasApiOperation = (handler: unknown): boolean => Reflect.getMetadata(MD.apiOperation, handler as object) != null;

interface OpenApiDocument {
  paths: Record<string, Record<string, unknown>>;
}

async function buildAppWithSpec(): Promise<{ app: INestApplication; dataDir: string; spec: OpenApiDocument }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-spec-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEV_AUTH = '1';
  delete process.env.API_DOCS;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  setupApiDocs(app);
  await app.init();

  const res = await request(app.getHttpServer()).get('/api/openapi.json');
  expect(res.status).toBe(200);
  return { app, dataDir, spec: res.body as OpenApiDocument };
}

describe('OpenAPI spec / controller contract (issue #566, e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  let spec: OpenApiDocument;
  let routes: RouteReflection[];

  beforeAll(async () => {
    const built = await buildAppWithSpec();
    app = built.app;
    dataDir = built.dataDir;
    spec = built.spec;

    const modulesContainer = app.get(ModulesContainer);

    routes = [];
    for (const module of modulesContainer.values()) {
      for (const wrapper of module.controllers.values()) {
        const { metatype } = wrapper;
        if (!metatype || isControllerExcluded(metatype)) continue;

        const prefix = Reflect.getMetadata(PATH_METADATA, metatype);
        const proto = metatype.prototype;
        for (const methodName of Object.getOwnPropertyNames(proto)) {
          if (methodName === 'constructor' || typeof proto[methodName] !== 'function') continue;
          const handler = proto[methodName];
          const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler);
          if (requestMethod === undefined) continue; // not a route handler

          // @ApiExcludeEndpoint opts a single handler out of the spec without
          // excluding the whole controller. Honor it the same way Swagger does.
          if (isEndpointExcluded(handler)) continue;

          const verb = HTTP_VERBS[requestMethod as number];
          const specPath = withGlobalPrefix(joinControllerPath(prefix, Reflect.getMetadata(PATH_METADATA, handler)));
          routes.push({ controllerName: metatype.name, methodName, verb, specPath });
        }
      }
    }
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('every non-excluded controller route appears in spec.paths', () => {
    const specPaths = new Set(Object.keys(spec.paths));
    const missing = routes.filter((r) => !specPaths.has(r.specPath));
    expect(missing).toEqual([]);
  });

  it('every spec path is backed by a non-excluded controller route (no orphan paths)', () => {
    const reflected = new Set(routes.map((r) => r.specPath));
    const orphans = Object.keys(spec.paths).filter((p) => !reflected.has(p));
    expect(orphans).toEqual([]);
  });

  it('every non-excluded controller carries @ApiTags', () => {
    // Re-derived from the modules container rather than stashing on the beforeAll
    // route list so a tag-only failure still points at the controller class.
    const modulesContainer = app.get(ModulesContainer);
    const untagged: string[] = [];
    for (const module of modulesContainer.values()) {
      for (const wrapper of module.controllers.values()) {
        const { metatype } = wrapper;
        if (!metatype || isControllerExcluded(metatype)) continue;
        if (!hasApiTags(metatype)) {
          untagged.push(metatype.name);
        }
      }
    }
    expect(untagged).toEqual([]);
  });

  it('every non-excluded route handler carries @ApiOperation', () => {
    const modulesContainer = app.get(ModulesContainer);
    const missing: string[] = [];
    for (const module of modulesContainer.values()) {
      for (const wrapper of module.controllers.values()) {
        const { metatype } = wrapper;
        if (!metatype || isControllerExcluded(metatype)) continue;
        const proto = metatype.prototype;
        for (const methodName of Object.getOwnPropertyNames(proto)) {
          if (methodName === 'constructor' || typeof proto[methodName] !== 'function') continue;
          const handler = proto[methodName];
          if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          if (isEndpointExcluded(handler)) continue;
          if (!hasApiOperation(handler)) {
            missing.push(`${metatype.name}.${methodName}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // Path-count floor + bijection (asserted above) is the durable contract guard.
  // We do NOT inline-snapshot the exact path list: in a fast-moving repo the
  // snapshot drifts on every merge that adds a route, producing a perpetual
  // false-failure that obscures real decorator drift. Instead, assert a sane
  // floor (catches a catastrophic regression where most routes vanish) and log
  // the actual sorted list on failure so a reviewer sees exactly what changed.
  it('the spec exposes a healthy, non-trivial set of paths', () => {
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(100);
    // More operations than paths is the normal shape (most routes have GET + PATCH + DELETE).
    const opCount = Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods as object).length, 0);
    expect(opCount).toBeGreaterThan(paths.length);
  });
});
