import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { ServerAuditController } from './server-audit.controller';
import { AuditRetentionController } from './audit-retention.controller';

@Module({
  imports: [RoleAccessModule],
  controllers: [AuditController, ServerAuditController, AuditRetentionController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
