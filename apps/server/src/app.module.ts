import { join } from 'path';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ZodValidationPipe } from 'nestjs-zod';
import { DbModule } from './db/db.module';
import { SessionAuthGuard } from './common/guards/session-auth.guard';
import { ServerRolesGuard } from './common/guards/server-roles.guard';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SettingsModule } from './modules/settings/settings.module';
import { MembershipModule } from './modules/membership/membership.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CharactersModule } from './modules/characters/characters.module';
import { QuestsModule } from './modules/quests/quests.module';
import { NpcsModule } from './modules/npcs/npcs.module';
import { LocationsModule } from './modules/locations/locations.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { NotesModule } from './modules/notes/notes.module';
import { AuditModule } from './modules/audit/audit.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { ProposalsModule } from './modules/proposals/proposals.module';
import { ExportModule } from './modules/export/export.module';
import { RulesModule } from './modules/rules/rules.module';
import { McpModule } from './modules/mcp/mcp.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { EncountersModule } from './modules/encounters/encounters.module';

/**
 * Single-image production packaging: the compiled web SPA can be served directly by
 * this API process (same origin, no reverse proxy required) out of WEB_DIST (default
 * <server-dist>/../../web-dist, i.e. /app/web-dist in the production image layout).
 *
 * Activation is opt-in-by-default-in-prod, not always-on:
 *  - WEB_DIST env explicitly set               -> always serve, any NODE_ENV
 *  - NODE_ENV=production and WEB_DIST unset    -> serve from the default path
 *  - otherwise (plain dev)                     -> no-op; ServeStaticModule is left out
 *    of `imports` entirely so it registers no middleware and Vite (:5173) remains the
 *    only place serving the SPA in dev, exactly like today.
 *
 * exclude uses the (.*) capture-group wildcard, not `{*splat}` — this package is
 * @nestjs/serve-static@4.x (the only major compatible with our Nest 10 / Express 4
 * runtime; v5 requires Nest 11), which resolves paths with path-to-regexp@0.2.5. That
 * ancient version treats a bare `*` as a literal asterisk character and matches plain
 * strings as exact paths (not prefixes) — only `(.*)` behaves as a wildcard segment.
 * Verified against path-to-regexp@0.2.5 directly: '/api/v1' alone does NOT match
 * '/api/v1/campaigns', but '/api/v1/(.*)' does.
 */
function serveStaticImports(): DynamicModule[] {
  const webDist = process.env.WEB_DIST || (process.env.NODE_ENV === 'production' ? join(__dirname, '../../web-dist') : undefined);
  if (!webDist) {
    return [];
  }
  return [
    ServeStaticModule.forRoot({
      rootPath: webDist,
      exclude: [
        '/api/v1/(.*)',
        '/api/v1',
        '/healthz',
        '/mcp',
        '/api/docs/(.*)',
        '/api/docs',
        '/api/docs-json',
        '/api/openapi.json',
      ],
    }),
  ];
}

@Module({
  imports: [
    ...serveStaticImports(),
    DbModule,
    HealthModule,
    AuthModule,
    TokensModule,
    UsersModule,
    SettingsModule,
    MembershipModule,
    AuditModule,
    CampaignsModule,
    CharactersModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    SessionsModule,
    NotesModule,
    ProposalsModule,
    ExportModule,
    RulesModule,
    McpModule,
    AttachmentsModule,
    EncountersModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: ServerRolesGuard },
  ],
})
export class AppModule {}
