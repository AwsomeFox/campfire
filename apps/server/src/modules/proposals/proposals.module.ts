import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CharactersModule } from '../characters/characters.module';
import { ProposalRecordsModule } from './proposal-records.module';
import { ProposalsService } from './proposals.service';
import { CampaignProposalsController, ProposalsController } from './proposals.controller';

@Module({
  imports: [
    AuditModule,
    RoleAccessModule,
    ProposalRecordsModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    SessionsModule,
    CharactersModule,
  ],
  controllers: [CampaignProposalsController, ProposalsController],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
