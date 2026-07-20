import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module';
import { SESSION_COOKIE_NAME } from './modules/auth/auth.constants';

patchNestJsSwagger();

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
  // setting value directly (e.g. a hop count, or 'false' to disable) for deployments
  // behind more than one proxy hop; defaults to trusting exactly one hop.
  // Goes through the underlying Express instance (rather than the NestExpressApplication-only
  // app.set() wrapper) so this works against the plain INestApplication type this function is
  // typed with — same type test/main-hardening.e2e-spec.ts builds against.
  const trustProxy = process.env.TRUST_PROXY;
  const expressInstance = app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void };
  expressInstance.set('trust proxy', trustProxy !== undefined ? (trustProxy === 'false' ? false : trustProxy) : 1);

  app.use(helmet());
  app.use(cookieParser());
  // Explicit body-size cap on JSON/urlencoded bodies — unbounded request bodies are a
  // resource-exhaustion vector on any authenticated (or unauthenticated, e.g. /auth/login)
  // write endpoint. Multipart uploads (attachments) go through multer's own FileInterceptor
  // size limit, not these parsers, so this cap doesn't affect them.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  const corsOrigin = resolveCorsOrigin();
  if (corsOrigin) {
    app.enableCors({
      origin: corsOrigin,
      credentials: true,
    });
  }

  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'mcp', 'api/docs', 'api/docs-json', 'api/openapi.json'],
  });
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

  const config = new DocumentBuilder()
    .setTitle('Campfire API')
    .setDescription(
      'Self-hosted D&D campaign tracker API. Real local auth via httpOnly session cookie ' +
        `(${SESSION_COOKIE_NAME}) — see /api/v1/auth/status, /auth/setup, /auth/login. ` +
        'Dev auth (opt-in, DEV_AUTH=1 env): pass x-dev-role (dm|player|viewer, default dm) and ' +
        'x-dev-user (default dev-user) headers when no session cookie is present — used by e2e tests only.',
    )
    .setVersion('0.1.0')
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
    .addApiKey({ type: 'apiKey', name: 'x-dev-role', in: 'header', description: 'dev-auth only (DEV_AUTH=1): dm | player | viewer (default dm)' }, 'x-dev-role')
    .addApiKey({ type: 'apiKey', name: 'x-dev-user', in: 'header', description: 'dev-auth only (DEV_AUTH=1): dev user id (default dev-user)' }, 'x-dev-user')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'cf_pat_<48 hex>', description: 'Personal access token — Authorization: Bearer cf_pat_...' },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
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
