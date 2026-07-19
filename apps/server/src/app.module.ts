import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { DbModule } from './db/db.module';
import { DevAuthGuard } from './common/guards/dev-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { HealthModule } from './modules/health/health.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CharactersModule } from './modules/characters/characters.module';
import { QuestsModule } from './modules/quests/quests.module';
import { NpcsModule } from './modules/npcs/npcs.module';
import { LocationsModule } from './modules/locations/locations.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { NotesModule } from './modules/notes/notes.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    DbModule,
    HealthModule,
    AuditModule,
    CampaignsModule,
    CharactersModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    SessionsModule,
    NotesModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: DevAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
