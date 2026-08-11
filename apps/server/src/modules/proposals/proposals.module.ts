import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CharactersModule } from '../characters/characters.module';
import { EncountersModule } from '../encounters/encounters.module';
import { MapsModule } from '../maps/maps.module';
import { FactionsModule } from '../factions/factions.module';
import { StorylinesModule } from '../storylines/storylines.module';
import { RulesModule } from '../rules/rules.module';
import { TimelineModule } from '../timeline/timeline.module';
import { ProposalRecordsModule } from './proposal-records.module';
import { ProposalsService } from './proposals.service';
import { CampaignProposalsController, ProposalsController } from './proposals.controller';

@Module({
  imports: [
    AuditModule,
    NotificationsModule,
    RoleAccessModule,
    ProposalRecordsModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    SessionsModule,
    CharactersModule,
    EncountersModule,
    MapsModule,
    FactionsModule,
    StorylinesModule,
    RulesModule,
    TimelineModule,
  ],
  controllers: [CampaignProposalsController, ProposalsController],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
