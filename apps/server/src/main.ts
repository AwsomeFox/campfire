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
 * Prod-hardening middleware + CORS + global prefix, applied to an already-constructed
 * Nest app. Factored out of bootstrap() so test/main-hardening.e2e-spec.ts can exercise
 * the exact same configuration against a Test.createTestingModule()-built app (which,
 * unlike test/test-app.ts's createTestApp(), never runs through this file's bootstrap()
 * otherwise — see that file's header comment).
 */
export function configureApp(app: INestApplication): void {
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

async function bootstrap() {
  // bodyParser: false — Nest's default body-parser registration has no size limit, and
  // registering our own express.json()/urlencoded() afterward would just double-parse (Nest's
  // ExpressAdapter skips re-registering a parser it detects by middleware function name, but
  // relying on that name-sniff felt fragile). Disabling the default and registering explicitly
  // in configureApp() with a limit is the documented way to override Nest's body-parser options.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  configureApp(app);

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
