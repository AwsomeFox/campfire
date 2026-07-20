import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { SessionsService } from './sessions.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';

@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule, ProposalRecordsModule],
  controllers: [CampaignSessionsController, SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
