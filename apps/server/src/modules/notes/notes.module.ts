import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { NotesService } from './notes.service';
import { CampaignNotesController, NotesController } from './notes.controller';

@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule],
  controllers: [CampaignNotesController, NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
