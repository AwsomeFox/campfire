import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { QuestsService } from './quests.service';
import { CampaignQuestsController, QuestsController } from './quests.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, ProposalRecordsModule, RevisionsModule],
  controllers: [CampaignQuestsController, QuestsController],
  providers: [QuestsService],
  exports: [QuestsService],
})
export class QuestsModule {}
