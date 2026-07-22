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

  // Snapshot the full sorted path list: adding a route (or losing one) is a
  // deliberate `jest -u` review point, and the diff in the snapshot file is a
  // clean, reviewable record of how the public API surface changed. This is the
  // "new route requires an intentional snapshot update" guard from #566.
  it('the sorted spec path list matches the snapshot (deliberate update on route add/remove)', () => {
    expect(Object.keys(spec.paths).sort()).toMatchInlineSnapshot(`
[
  "/api/v1/admin/audit",
  "/api/v1/admin/membership-integrity",
  "/api/v1/admin/membership-integrity/repair-dm",
  "/api/v1/admin/metrics",
  "/api/v1/admin/storage",
  "/api/v1/admin/storage/campaigns/{campaignId}/quota",
  "/api/v1/admin/storage/cleanup",
  "/api/v1/arcs/{id}",
  "/api/v1/arcs/{id}/beats",
  "/api/v1/arcs/{id}/status",
  "/api/v1/attachments/{id}",
  "/api/v1/attachments/{id}/file",
  "/api/v1/attachments/{id}/hide",
  "/api/v1/attachments/{id}/reveal",
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
  "/api/v1/auth/oidc/callback",
  "/api/v1/auth/oidc/login",
  "/api/v1/auth/reset-confirm",
  "/api/v1/auth/reset-request",
  "/api/v1/auth/setup",
  "/api/v1/auth/signup",
  "/api/v1/auth/status",
  "/api/v1/auth/token",
  "/api/v1/backup",
  "/api/v1/backup/restore",
  "/api/v1/beats/{id}",
  "/api/v1/beats/{id}/branches",
  "/api/v1/beats/{id}/branches/{branchId}",
  "/api/v1/beats/{id}/status",
  "/api/v1/calendar/{token}.ics",
  "/api/v1/campaigns",
  "/api/v1/campaigns/import",
  "/api/v1/campaigns/import/archive",
  "/api/v1/campaigns/trash",
  "/api/v1/campaigns/{campaignId}/arcs",
  "/api/v1/campaigns/{campaignId}/attachments",
  "/api/v1/campaigns/{campaignId}/calendar-feed",
  "/api/v1/campaigns/{campaignId}/characters",
  "/api/v1/campaigns/{campaignId}/characters/import-ddb",
  "/api/v1/campaigns/{campaignId}/characters/xp",
  "/api/v1/campaigns/{campaignId}/comments",
  "/api/v1/campaigns/{campaignId}/encounters",
  "/api/v1/campaigns/{campaignId}/encounters/generate",
  "/api/v1/campaigns/{campaignId}/events",
  "/api/v1/campaigns/{campaignId}/export",
  "/api/v1/campaigns/{campaignId}/export/me",
  "/api/v1/campaigns/{campaignId}/factions",
  "/api/v1/campaigns/{campaignId}/inbox",
  "/api/v1/campaigns/{campaignId}/inventory",
  "/api/v1/campaigns/{campaignId}/invites",
  "/api/v1/campaigns/{campaignId}/invites/{inviteId}",
  "/api/v1/campaigns/{campaignId}/locations",
  "/api/v1/campaigns/{campaignId}/maps/generate",
  "/api/v1/campaigns/{campaignId}/maps/import",
  "/api/v1/campaigns/{campaignId}/maps/sources",
  "/api/v1/campaigns/{campaignId}/members",
  "/api/v1/campaigns/{campaignId}/members/{memberId}",
  "/api/v1/campaigns/{campaignId}/mentions",
  "/api/v1/campaigns/{campaignId}/notes",
  "/api/v1/campaigns/{campaignId}/npcs",
  "/api/v1/campaigns/{campaignId}/proposals",
  "/api/v1/campaigns/{campaignId}/quests",
  "/api/v1/campaigns/{campaignId}/quests/changes",
  "/api/v1/campaigns/{campaignId}/roll",
  "/api/v1/campaigns/{campaignId}/rolls",
  "/api/v1/campaigns/{campaignId}/schedule",
  "/api/v1/campaigns/{campaignId}/schedule/next",
  "/api/v1/campaigns/{campaignId}/search",
  "/api/v1/campaigns/{campaignId}/session-zero",
  "/api/v1/campaigns/{campaignId}/sessions",
  "/api/v1/campaigns/{campaignId}/timeline",
  "/api/v1/campaigns/{campaignId}/timeline/calendar",
  "/api/v1/campaigns/{campaignId}/treasury",
  "/api/v1/campaigns/{id}",
  "/api/v1/campaigns/{id}/ai-dm",
  "/api/v1/campaigns/{id}/ai-dm/draft",
  "/api/v1/campaigns/{id}/ai-dm/flag",
  "/api/v1/campaigns/{id}/ai-dm/grant-takeover",
  "/api/v1/campaigns/{id}/ai-dm/handback",
  "/api/v1/campaigns/{id}/ai-dm/message",
  "/api/v1/campaigns/{id}/ai-dm/nudge",
  "/api/v1/campaigns/{id}/ai-dm/pause",
  "/api/v1/campaigns/{id}/ai-dm/request-takeover",
  "/api/v1/campaigns/{id}/ai-dm/reset",
  "/api/v1/campaigns/{id}/ai-dm/resume",
  "/api/v1/campaigns/{id}/ai-dm/rules-lookup",
  "/api/v1/campaigns/{id}/ai-dm/session",
  "/api/v1/campaigns/{id}/ai-dm/stream",
  "/api/v1/campaigns/{id}/ai-dm/turn",
  "/api/v1/campaigns/{id}/ai-dm/vote",
  "/api/v1/campaigns/{id}/ai-provider",
  "/api/v1/campaigns/{id}/ai-provider/effective",
  "/api/v1/campaigns/{id}/ai-provider/key",
  "/api/v1/campaigns/{id}/ai-provider/test",
  "/api/v1/campaigns/{id}/audit",
  "/api/v1/campaigns/{id}/clone",
  "/api/v1/campaigns/{id}/purge",
  "/api/v1/campaigns/{id}/restore",
  "/api/v1/campaigns/{id}/scribe",
  "/api/v1/campaigns/{id}/scribe/jobs",
  "/api/v1/campaigns/{id}/scribe/run",
  "/api/v1/campaigns/{id}/summary",
  "/api/v1/campaigns/{id}/trash",
  "/api/v1/characters/{id}",
  "/api/v1/characters/{id}/conditions",
  "/api/v1/characters/{id}/hp",
  "/api/v1/characters/{id}/level-up",
  "/api/v1/characters/{id}/restore",
  "/api/v1/characters/{id}/spell-slots",
  "/api/v1/characters/{id}/xp",
  "/api/v1/comments/{id}",
  "/api/v1/comments/{id}/restore",
  "/api/v1/encounters/{id}",
  "/api/v1/encounters/{id}/combatants",
  "/api/v1/encounters/{id}/combatants/{cid}",
  "/api/v1/encounters/{id}/difficulty",
  "/api/v1/encounters/{id}/end",
  "/api/v1/encounters/{id}/events",
  "/api/v1/encounters/{id}/generate-map",
  "/api/v1/encounters/{id}/next-turn",
  "/api/v1/encounters/{id}/ping",
  "/api/v1/encounters/{id}/reopen",
  "/api/v1/encounters/{id}/roll-initiative",
  "/api/v1/encounters/{id}/start",
  "/api/v1/factions/{id}",
  "/api/v1/factions/{id}/reputation",
  "/api/v1/inventory/{id}",
  "/api/v1/invites/{code}",
  "/api/v1/invites/{code}/accept",
  "/api/v1/invites/{code}/join",
  "/api/v1/locations/{id}",
  "/api/v1/locations/{id}/discover",
  "/api/v1/locations/{id}/restore",
  "/api/v1/me",
  "/api/v1/me/password",
  "/api/v1/me/preferences",
  "/api/v1/notes/{id}",
  "/api/v1/notes/{id}/resolve",
  "/api/v1/notes/{id}/restore",
  "/api/v1/notifications",
  "/api/v1/notifications/read-all",
  "/api/v1/notifications/unread-count",
  "/api/v1/notifications/{id}/read",
  "/api/v1/npcs/{id}",
  "/api/v1/npcs/{id}/restore",
  "/api/v1/proposals/batch/approve",
  "/api/v1/proposals/batch/reject",
  "/api/v1/proposals/{id}",
  "/api/v1/proposals/{id}/approve",
  "/api/v1/proposals/{id}/reject",
  "/api/v1/proposals/{id}/withdraw",
  "/api/v1/quests/{id}",
  "/api/v1/quests/{id}/objectives",
  "/api/v1/quests/{id}/objectives/reorder",
  "/api/v1/quests/{id}/objectives/{oid}",
  "/api/v1/quests/{id}/restore",
  "/api/v1/quests/{id}/status",
  "/api/v1/revisions/{entityType}/{entityId}",
  "/api/v1/revisions/{entityType}/{entityId}/{revisionId}/restore",
  "/api/v1/rules/entries/{id}",
  "/api/v1/rules/packs",
  "/api/v1/rules/packs/install",
  "/api/v1/rules/packs/install-jobs/{id}",
  "/api/v1/rules/packs/upload",
  "/api/v1/rules/packs/{id}",
  "/api/v1/rules/search",
  "/api/v1/rules/sources",
  "/api/v1/schedule/{id}",
  "/api/v1/schedule/{id}/rsvp",
  "/api/v1/sessions/{id}",
  "/api/v1/sessions/{id}/attendance",
  "/api/v1/sessions/{id}/restore",
  "/api/v1/sessions/{sessionId}/shares",
  "/api/v1/sessions/{sessionId}/shares/{shareId}",
  "/api/v1/settings",
  "/api/v1/settings/ai",
  "/api/v1/settings/ai-provider",
  "/api/v1/settings/ai-provider/key",
  "/api/v1/settings/ai-provider/test",
  "/api/v1/settings/ai/allowlist",
  "/api/v1/settings/ai/caps",
  "/api/v1/settings/ai/health",
  "/api/v1/settings/ai/kill",
  "/api/v1/settings/ai/usage",
  "/api/v1/settings/oidc",
  "/api/v1/settings/oidc/test",
  "/api/v1/shared/recaps/{token}",
  "/api/v1/timeline/{id}",
  "/api/v1/tokens",
  "/api/v1/tokens/{id}",
  "/api/v1/users",
  "/api/v1/users/lookup",
  "/api/v1/users/reset-requests",
  "/api/v1/users/reset-requests/{id}",
  "/api/v1/users/reset-requests/{id}/approve",
  "/api/v1/users/{id}",
  "/api/v1/users/{id}/password",
  "/api/v1/users/{id}/tokens",
  "/api/v1/users/{id}/tokens/{tokenId}",
  "/healthz",
  "/readyz",
]
`);
  });

  it('spec path count and operation count are non-trivial (sanity guard against an empty spec)', () => {
    const pathCount = Object.keys(spec.paths).length;
    const operationCount = Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods).length, 0);
    // These reflectors enumerated at least one route, so the app booted with
    // controllers; the spec must therefore be substantial. The exact floor is
    // intentionally loose — the snapshot above is the precise guard — but this
    // catches a catastrophic regression (e.g. setupApiDocs becoming a no-op) with
    // a clearer signal than an empty-array equality.
    expect(pathCount).toBeGreaterThan(100);
    expect(operationCount).toBeGreaterThan(pathCount);
  });
});
