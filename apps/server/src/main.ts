import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module';
import { SESSION_COOKIE_NAME } from './modules/auth/auth.constants';
import { APP_VERSION } from './common/build-metadata';
import { resolveTrustProxy, resolveAllowInsecureHttp, isDevAuthActive } from './common/security-config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requestContextMiddleware } from './common/request-context.middleware';
import { normalizeMissingBody } from './common/normalize-body.middleware';
import { registerErrorSchemas } from './common/openapi-error-schemas';

patchNestJsSwagger();

/**
 * Issue #2126: a process-level safety net so a stray unhandled stream-write error on a
 * destroyed SSE response can never silently kill the server. Without this, writing to a
 * closed socket after a client disconnect emits an 'error' with no listener, which Node
 * treats as a fatal uncaught exception — tearing the process down with zero log output.
 * The SSE controller's takeUntil(req 'close') is the primary fix; this handler is
 * defense-in-depth so any future long-lived stream that races the same way is LOGGED
 * (never again "no output when it dies") rather than silently terminating the process.
 *
 * We only swallow the known-benign stream-write class (ERR_STREAM_* / write-after-end /
 * EPIPE / ECONNRESET on a disconnected client). Everything else is logged at FATAL so a
 * genuine bug is loud, not silent.
 */
const bootstrapLogger = new Logger('Bootstrap');
const STREAM_DISCONNECT_CODES = new Set(['ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PUSH_AFTER_EOF']);
const STREAM_DISCONNECT_ERRNO = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED']);

function isBenignStreamDisconnect(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return STREAM_DISCONNECT_CODES.has(code ?? '') || STREAM_DISCONNECT_ERRNO.has(code ?? '');
}

process.on('uncaughtException', (err) => {
  if (isBenignStreamDisconnect(err)) {
    bootstrapLogger.warn(`Benign stream-write error on a disconnected client (swallowed): ${err.message}`);
    return;
  }
  // A non-benign uncaught exception means the process may be in an undefined state (partial
  // writes, corrupted in-memory state). Log loudly, then exit non-zero so a supervisor (Docker,
  // systemd) restarts cleanly — matching Node's default fail-fast behavior, just no longer silent.
  bootstrapLogger.error(`FATAL uncaught exception (exiting): ${err.message}`, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (isBenignStreamDisconnect(reason)) {
    bootstrapLogger.warn(`Benign stream-write rejection on a disconnected client (swallowed): ${reason instanceof Error ? reason.message : String(reason)}`);
    return;
  }
  bootstrapLogger.error(
    `FATAL unhandled promise rejection (exiting): ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
  );
  process.exit(1);
});

/**
 * CORS origin resolution:
 *  - ORIGIN env (comma-split, e.g. "https://campfire.example.com,https://alt.example.com")
 *    takes priority whenever set, in any environment.
 *  - Else, outside production: default to the Vite dev server origin (localhost:5173) —
 *    matches every existing e2e/dev workflow.
 *  - Else (production, no ORIGIN set): CORS is disabled entirely (`enableCors` not called).
 *    The deployment plan is same-origin serving (web build served by this same API process
 *    or a reverse proxy in front of both), so no cross-origin requests are expected in
 *    production unless an operator opts in via ORIGIN.
 */
export function resolveCorsOrigin(): string[] | undefined {
  const raw = process.env.ORIGIN;
  if (raw && raw.trim().length > 0) {
    return raw.split(',').map((o) => o.trim()).filter(Boolean);
  }
  if (process.env.NODE_ENV !== 'production') {
    return ['http://localhost:5173'];
  }
  return undefined;
}

/**
 * Swagger UI / OpenAPI JSON exposure resolution (issue #46):
 *  - API_DOCS env takes priority whenever set, in any environment:
 *    '1'/'true' force-enables, '0'/'false' force-disables.
 *  - Else, outside production: enabled — the docs are part of the everyday dev
 *    workflow (`just api-docs`, e2e tooling, agent self-discovery).
 *  - Else (production, no API_DOCS set): disabled. The endpoints leak no data
 *    (every real route still enforces auth), but the full API surface being
 *    browsable by anyone who can reach the server is needless attack-surface
 *    disclosure — operators who want public docs opt back in via API_DOCS=1.
 */
export function resolveDocsEnabled(): boolean {
  const raw = process.env.API_DOCS?.trim().toLowerCase();
  if (raw === '1' || raw === 'true') {
    return true;
  }
  if (raw === '0' || raw === 'false') {
    return false;
  }
  return process.env.NODE_ENV !== 'production';
}

/**
 * Prod-hardening middleware + CORS + global prefix, applied to an already-constructed
 * Nest app. Factored out of bootstrap() so test/main-hardening.e2e-spec.ts can exercise
 * the exact same configuration against a Test.createTestingModule()-built app (which,
 * unlike test/test-app.ts's createTestApp(), never runs through this file's bootstrap()
 * otherwise — see that file's header comment).
 */
export function configureApp(app: INestApplication): void {
  // Trust the first hop's X-Forwarded-For (Traefik in production — see deployment docs).
  // Required for ThrottlerGuard's per-IP rate limiting (P2 DoS fix) to see the real client
  // IP rather than bucketing every request under the reverse proxy's own address; also
  // makes req.ip/req.secure correct generally. TRUST_PROXY env overrides the Express
  // setting for deployments behind more than one proxy hop; defaults to trusting exactly
  // one hop. resolveTrustProxy() coerces the string env into what Express expects — a
  // NUMBER for a hop count, boolean for true/false — since Express reads a raw string as
  // an IP allow-list, so `"2"` would silently disable trust (issue #165).
  // Goes through the underlying Express instance (rather than the NestExpressApplication-only
  // app.set() wrapper) so this works against the plain INestApplication type this function is
  // typed with — same type test/main-hardening.e2e-spec.ts builds against.
  const expressInstance = app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void };
  expressInstance.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));

  // Plain-HTTP LAN escape hatch (issue #117): when ALLOW_INSECURE_HTTP is set, drop the two
  // helmet defaults that break a no-TLS homelab deployment — CSP `upgrade-insecure-requests`
  // (which rewrites every subresource/`/api` request to https://… where nothing listens) and
  // HSTS. Default (unset) is unchanged: full helmet defaults, secure for TLS deployments.
  app.use(
    resolveAllowInsecureHttp()
      ? helmet({
          contentSecurityPolicy: {
            useDefaults: true,
            directives: { upgradeInsecureRequests: null },
          },
          hsts: false,
        })
      : helmet(),
  );
  app.use(cookieParser());
  // Explicit body-size cap on JSON/urlencoded bodies — unbounded request bodies are a
  // resource-exhaustion vector on any authenticated (or unauthenticated, e.g. /auth/login)
  // write endpoint. Multipart uploads (attachments) go through multer's own FileInterceptor
  // size limit, not these parsers, so this cap doesn't affect them.
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));
  // Issue #580 — a POST with no payload must reach the handler as `{}`, not `undefined`.
  // See normalize-body.middleware.ts for the body-parser 1.x/2.x divergence behind this.
  app.use(normalizeMissingBody);
  // Issue #682 / #684 — per-request id on every response + AsyncLocalStorage context
  // for structured logs, audit rows, MCP envelopes, and provider retries.
  app.use(requestContextMiddleware);

  const corsOrigin = resolveCorsOrigin();
  if (corsOrigin) {
    app.enableCors({
      origin: corsOrigin,
      credentials: true,
    });
  }

  app.setGlobalPrefix('api/v1', {
    exclude: [
      'healthz',
      'readyz',
      'mcp',
      // MCP OAuth (issue #37): authorization-server + protected-resource metadata
      // and the OAuth endpoints must live at the application root, not under /api/v1.
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

  // Issue #682 — global REST exception filter: shapes every escaped exception
  // into the published Problem Details-style envelope and stamps an
  // `X-Request-Id` on every response. Registered in configureApp() (not the
  // AppModule APP_FILTER token) so test/test-app.ts's app, which DOESN'T run
  // through this function, can opt in explicitly — keeping the production and
  // test wiring identical and discoverable from a single source of truth.
  app.useGlobalFilters(new AllExceptionsFilter());
}

/**
 * Swagger UI (/api/docs) + OpenAPI JSON (/api/openapi.json) registration, gated by
 * resolveDocsEnabled() — a no-op (routes 404) when the docs are disabled. Factored out
 * of bootstrap() for the same reason as configureApp(): so test/api-docs.e2e-spec.ts
 * can exercise the exact same registration (and its gating) against a
 * Test.createTestingModule()-built app.
 */
export function setupApiDocs(app: INestApplication): void {
  if (!resolveDocsEnabled()) {
    return;
  }

  // Only advertise the dev-auth headers in the docs when dev auth is actually active
  // (DEV_AUTH=1 and non-production) — no point documenting a bypass that the guard
  // hard-disables in production (issue #119).
  const devAuth = isDevAuthActive();

  const config = new DocumentBuilder()
    .setTitle('Campfire API')
    .setDescription(
      'Self-hosted D&D campaign tracker API. Real local auth via httpOnly session cookie ' +
        `(${SESSION_COOKIE_NAME}) — see /api/v1/auth/status, /auth/setup, /auth/login.` +
        (devAuth
          ? ' Dev auth (active — DEV_AUTH=1, non-production): pass x-dev-role (dm|player|viewer, default dm) and ' +
            'x-dev-user (default dev-user) headers when no session cookie is present — used by e2e tests only.'
          : ''),
    )
    .setVersion(APP_VERSION)
    .addTag('auth')
    .addTag('users')
    .addTag('settings')
    .addTag('members')
    .addTag('campaigns')
    .addTag('characters')
    .addTag('quests')
    .addTag('npcs')
    .addTag('locations')
    .addTag('sessions')
    .addTag('notes')
    .addTag('attachments')
    .addTag('audit')
    .addTag('tokens')
    .addTag('proposals')
    .addTag('export')
    .addTag('health')
    .addCookieAuth(SESSION_COOKIE_NAME, { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME })
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'cf_pat_<48 hex>', description: 'Personal access token — Authorization: Bearer cf_pat_...' },
      'bearer',
    );

  if (devAuth) {
    config
      .addApiKey({ type: 'apiKey', name: 'x-dev-role', in: 'header', description: 'dev-auth only (DEV_AUTH=1): dm | player | viewer (default dm)' }, 'x-dev-role')
      .addApiKey({ type: 'apiKey', name: 'x-dev-user', in: 'header', description: 'dev-auth only (DEV_AUTH=1): dev user id (default dev-user)' }, 'x-dev-user');
  }

  const builtConfig = config.build();

  const document = SwaggerModule.createDocument(app, builtConfig);
  // Issue #682 — publish the machine-readable error response schemas (the
  // same envelope the global AllExceptionsFilter emits) as named components,
  // and attach a default 4xx/5xx ErrorResponse to every operation so generated
  // clients can resolve a typed error type per route instead of `unknown`.
  registerErrorSchemas(document);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/openapi.json',
  });
}

async function bootstrap() {
  // bodyParser: false — Nest's default body-parser registration has no size limit, and
  // registering our own express.json()/urlencoded() afterward would just double-parse (Nest's
  // ExpressAdapter skips re-registering a parser it detects by middleware function name, but
  // relying on that name-sniff felt fragile). Disabling the default and registering explicitly
  // in configureApp() with a limit is the documented way to override Nest's body-parser options.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks(); // graceful SIGTERM as PID 1 (docker stop)

  configureApp(app);
  setupApiDocs(app);

  // Loud boot-time warning whenever the DEV_AUTH bypass is live (issue #119): it turns
  // every uncredentialed request into a synthetic server-admin, so an operator must never
  // hit it by accident. (The guard hard-disables it in production regardless — this warns
  // for the non-production case where it IS active, e.g. a homelab left in dev mode.)
  if (isDevAuthActive()) {
    new Logger('Bootstrap').warn(
      'DEV_AUTH=1 is ACTIVE — authentication is bypassed and every uncredentialed request ' +
        'is granted server-admin. This is for e2e tests/local dev only; NEVER enable it on a ' +
        'reachable server. (Ignored entirely when NODE_ENV=production.)',
    );
  } else if (process.env.DEV_AUTH === '1') {
    new Logger('Bootstrap').warn('DEV_AUTH=1 is set but IGNORED because NODE_ENV=production (issue #119).');
  }

  // Issue #527: SSE real-time (campaign events + AI DM narration) is single-instance only.
  // The pub/sub backing it (CampaignEventsService / AiDmStreamService) is an in-process
  // RxJS Subject — events emitted on one node never reach subscribers connected to another.
  // A revoked member on a different node would NOT be disconnected, and cross-node members
  // would miss live ticks entirely. There is no reliable way to detect sibling instances
  // from inside the app without external coordination (a shared Redis / DB heartbeat), so
  // this is a documented static caveat rather than a detection: if you scale horizontally,
  // add a shared transport (Redis pub/sub) and route emit()/streamFor() through it, or keep
  // the deployment to a single replica behind sticky sessions.
  new Logger('Bootstrap').warn(
    'SSE (campaign events + AI DM narration) is single-instance: the in-process RxJS pub/sub does NOT ' +
      'fan out across multiple server nodes. Run a single replica, or add a shared transport (Redis pub/sub) ' +
      'before scaling horizontally — otherwise members on other nodes miss events and revocation (issue #527) ' +
      'will not disconnect a removed member connected elsewhere.',
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 8080;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Campfire API listening on port ${port}`);
}

// Only auto-run when this file is the actual process entrypoint (`node dist/main.js`,
// or `nest start`) — NOT when some other module (e.g. a test importing configureApp()/
// resolveCorsOrigin() for unit testing) merely requires this file. Without this guard,
// importing main.ts from anywhere calls bootstrap() as a side effect and tries to bind
// the real port (8080 by default), which — in this dev environment — collides with the
// actual running server. CommonJS-only check (apps/server compiles to commonjs).
if (require.main === module) {
  bootstrap();
}
