import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { SessionsService } from './sessions.service';
import { SchedulingService } from './scheduling.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';
import {
  CampaignScheduleController,
  ScheduleController,
  CampaignCalendarFeedController,
  CalendarFeedController,
} from './scheduling.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, ProposalRecordsModule],
  controllers: [
    CampaignSessionsController,
    SessionsController,
    CampaignScheduleController,
    ScheduleController,
    CampaignCalendarFeedController,
    CalendarFeedController,
  ],
  providers: [SessionsService, SchedulingService],
  exports: [SessionsService, SchedulingService],
})
export class SessionsModule {}
