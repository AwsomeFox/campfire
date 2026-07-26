import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsService } from './attachments.service';
import { AttachmentDerivativesService } from './attachment-derivatives.service';
import { FsDeletionService } from './fs-deletion.service';
import { CampaignAttachmentsController, AttachmentsController } from './attachments.controller';
import { StorageController } from './storage.controller';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignAttachmentsController, AttachmentsController, StorageController, DiagnosticsController],
  // AttachmentDerivativesService (issue #604) is exported so other modules that
  // serve map pixels (encounters) can read ladder state without reaching into the
  // attachments table themselves.
  providers: [AttachmentsService, AttachmentDerivativesService, DiagnosticsService, FsDeletionService],
  exports: [AttachmentsService, AttachmentDerivativesService, FsDeletionService],
})
export class AttachmentsModule {}
