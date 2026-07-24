import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { TimelineService } from './timeline.service';
import { CampaignTimelineController, TimelineController } from './timeline.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, RevisionsModule],
  controllers: [CampaignTimelineController, TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
