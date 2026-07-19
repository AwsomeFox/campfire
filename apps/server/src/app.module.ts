import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
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

@Module({
  imports: [
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
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: ServerRolesGuard },
  ],
})
export class AppModule {}
