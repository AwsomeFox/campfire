import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { SessionsService } from './sessions.service';
import { SessionSharesService } from './session-shares.service';
import { SchedulingService } from './scheduling.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';
import { CampaignSessionSharesController, SessionSharesController, SharedRecapController } from './session-shares.controller';
import {
  CampaignScheduleController,
  ScheduleController,
  CampaignCalendarFeedController,
  CalendarFeedController,
} from './scheduling.controller';

@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule, ProposalRecordsModule, RevisionsModule],
  controllers: [
    CampaignSessionsController,
    SessionsController,
    SessionSharesController,
    CampaignSessionSharesController,
    SharedRecapController,
    CampaignScheduleController,
    ScheduleController,
    CampaignCalendarFeedController,
    CalendarFeedController,
  ],
  providers: [SessionsService, SessionSharesService, SchedulingService],
  exports: [SessionsService, SessionSharesService, SchedulingService],
})
export class SessionsModule {}
