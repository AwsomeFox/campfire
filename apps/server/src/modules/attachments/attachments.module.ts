import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsService } from './attachments.service';
import { CampaignAttachmentsController, AttachmentsController } from './attachments.controller';
import { StorageController } from './storage.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignAttachmentsController, AttachmentsController, StorageController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
