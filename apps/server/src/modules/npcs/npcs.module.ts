import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { NpcsService } from './npcs.service';
import { CampaignNpcsController, NpcsController } from './npcs.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, ProposalRecordsModule, RevisionsModule],
  controllers: [CampaignNpcsController, NpcsController],
  providers: [NpcsService],
  exports: [NpcsService],
})
export class NpcsModule {}
