import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { SESSION_COOKIE_NAME } from './modules/auth/auth.constants';

patchNestJsSwagger();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  app.enableCors({
    origin: 'http://localhost:5173',
    credentials: true,
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'api/docs', 'api/docs-json', 'api/openapi.json'],
  });

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

bootstrap();
