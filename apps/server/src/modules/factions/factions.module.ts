import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { NpcsModule } from '../npcs/npcs.module';
import { FactionsService } from './factions.service';
import { CampaignFactionsController, FactionsController } from './factions.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, RevisionsModule, NpcsModule],
  controllers: [CampaignFactionsController, FactionsController],
  providers: [FactionsService],
  exports: [FactionsService],
})
export class FactionsModule {}
