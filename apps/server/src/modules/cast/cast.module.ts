import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { EncountersModule } from '../encounters/encounters.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { EventsModule } from '../events/events.module';
import { TableSafetyModule } from '../safety/table-safety.module';
import { CampaignCastSessionsController, PublicCastController } from './cast.controller';
import { CastService } from './cast.service';

@Module({
  imports: [AuditModule, CampaignsModule, EncountersModule, RoleAccessModule, EventsModule, TableSafetyModule],
  controllers: [CampaignCastSessionsController, PublicCastController],
  providers: [CastService],
  exports: [CastService],
})
export class CastModule {}
