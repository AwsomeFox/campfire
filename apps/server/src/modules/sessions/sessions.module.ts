import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { SessionsService } from './sessions.service';
import { SessionSharesService } from './session-shares.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';
import { SessionSharesController, SharedRecapController } from './session-shares.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, ProposalRecordsModule],
  controllers: [CampaignSessionsController, SessionsController, SessionSharesController, SharedRecapController],
  providers: [SessionsService, SessionSharesService],
  exports: [SessionsService],
})
export class SessionsModule {}
