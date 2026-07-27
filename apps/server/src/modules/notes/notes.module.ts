import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { ModerationModule } from '../moderation/moderation.module';
import { NotesService } from './notes.service';
import { CampaignNotesController, NotesController } from './notes.controller';

// ModerationModule (issue #601) supplies pre-mutation evidence capture and mute
// enforcement. One-way dependency: moderation never imports this module back.
@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule, RevisionsModule, ModerationModule],
  controllers: [CampaignNotesController, NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
