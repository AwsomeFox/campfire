import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsService } from './attachments.service';
import { CampaignAttachmentsController, AttachmentsController } from './attachments.controller';
import { StorageController } from './storage.controller';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignAttachmentsController, AttachmentsController, StorageController, DiagnosticsController],
  providers: [AttachmentsService, DiagnosticsService],
  exports: [AttachmentsService, DiagnosticsService],
})
export class AttachmentsModule {}
