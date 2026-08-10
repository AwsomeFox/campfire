import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { FactionsModule } from '../factions/factions.module';
import { LocationsModule } from '../locations/locations.module';
import { CharactersModule } from '../characters/characters.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EncountersModule } from '../encounters/encounters.module';
import { PersonalNavigationService } from './personal-navigation.service';
import { BookmarksController, RecentHistoryController } from './personal-navigation.controller';

/**
 * Personal navigation (issue #840): private bookmarks + bounded recent history.
 * Composes the same per-entity services as SearchModule so target visibility is
 * inherited from the tested `listForCampaign` lists rather than re-implemented.
 * REST-only by design (like catch-up): a per-user navigation surface is not a
 * shared campaign capability an AI agent operates on over MCP.
 */
@Module({
  imports: [
    AuditModule,
    RoleAccessModule,
    QuestsModule,
    NpcsModule,
    FactionsModule,
    LocationsModule,
    CharactersModule,
    SessionsModule,
    EncountersModule,
  ],
  controllers: [BookmarksController, RecentHistoryController],
  providers: [PersonalNavigationService],
})
export class PersonalNavigationModule {}
