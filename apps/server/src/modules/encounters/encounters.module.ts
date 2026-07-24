import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { EventsModule } from '../events/events.module';
import { RollsModule } from '../rolls/rolls.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { EncountersService } from './encounters.service';
import { EncounterMapService } from './encounter-map.service';
import { CampaignEncountersController, CampaignRollController, EncountersController } from './encounters.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, EventsModule, RollsModule, RevisionsModule, AttachmentsModule],
  controllers: [CampaignEncountersController, CampaignRollController, EncountersController],
  providers: [EncountersService, EncounterMapService],
  exports: [EncountersService],
})
export class EncountersModule {}
