import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { CommentsService } from './comments.service';
import { CampaignCommentsController, CommentsController } from './comments.controller';

@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule],
  controllers: [CampaignCommentsController, CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
