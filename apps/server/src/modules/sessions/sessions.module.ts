import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { EventsModule } from '../events/events.module';
import { EncountersModule } from '../encounters/encounters.module';
import { SessionsService } from './sessions.service';
import { SessionSharesService } from './session-shares.service';
import { SchedulingService } from './scheduling.service';
import { OrganizedPlayService } from './organized-play.service';
import { SessionRemindersService } from './session-reminders.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';
import { CampaignSessionSharesController, SessionSharesController, SharedRecapController } from './session-shares.controller';
import {
  CampaignScheduleController,
  ScheduleController,
  CampaignCalendarFeedController,
  CalendarFeedController,
} from './scheduling.controller';
import { CampaignSeriesController, OrganizedPlayController } from './organized-play.controller';

@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule, ProposalRecordsModule, RevisionsModule, EventsModule, EncountersModule],
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
    // Issue #588 — organized play. Registered AFTER ScheduleController so the
    // static `/organized-play/...` prefixes cannot shadow `/schedule/:id`.
    OrganizedPlayController,
    CampaignSeriesController,
  ],
  providers: [SessionsService, SessionSharesService, SchedulingService, OrganizedPlayService, SessionRemindersService],
  exports: [SessionsService, SessionSharesService, SchedulingService, OrganizedPlayService, SessionRemindersService],
})
export class SessionsModule {}
