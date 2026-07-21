import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsService } from './proposal-records.service';

/**
 * Leaf module (no dependency on domain modules) — see ProposalRecordsService
 * doc comment. Every domain module that wants to support `?proposed=true`
 * writes imports THIS, not ProposalsModule.
 */
@Module({
  imports: [AuditModule, NotificationsModule, RoleAccessModule],
  providers: [ProposalRecordsService],
  exports: [ProposalRecordsService],
})
export class ProposalRecordsModule {}
