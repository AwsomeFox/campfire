import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { EncountersService } from './encounters.service';
import { CampaignEncountersController, CampaignRollController, EncountersController } from './encounters.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignEncountersController, CampaignRollController, EncountersController],
  providers: [EncountersService],
  exports: [EncountersService],
})
export class EncountersModule {}
