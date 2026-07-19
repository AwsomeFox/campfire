import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import { AppModule } from './app.module';

patchNestJsSwagger();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: 'http://localhost:5173',
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'api/docs', 'api/docs-json', 'api/openapi.json'],
  });

  const config = new DocumentBuilder()
    .setTitle('Campfire API')
    .setDescription(
      'Self-hosted D&D campaign tracker API. Dev auth: pass x-dev-role (dm|player|viewer, default dm) ' +
        'and x-dev-user (default dev-user) headers — no OIDC yet.',
    )
    .setVersion('0.1.0')
    .addTag('campaigns')
    .addTag('characters')
    .addTag('quests')
    .addTag('npcs')
    .addTag('locations')
    .addTag('sessions')
    .addTag('notes')
    .addTag('audit')
    .addTag('health')
    .addApiKey({ type: 'apiKey', name: 'x-dev-role', in: 'header', description: 'dm | player | viewer (default dm)' }, 'x-dev-role')
    .addApiKey({ type: 'apiKey', name: 'x-dev-user', in: 'header', description: 'dev user id (default dev-user)' }, 'x-dev-user')
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
