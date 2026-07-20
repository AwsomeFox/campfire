import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { CampaignEventsService } from './campaign-events.service';
import { CampaignEventsController } from './events.controller';

@Module({
  imports: [RoleAccessModule],
  controllers: [CampaignEventsController],
  providers: [CampaignEventsService],
  exports: [CampaignEventsService],
})
export class EventsModule {}
