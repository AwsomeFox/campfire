import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';

/**
 * Whole-server backup & restore (issue #21). Server-admin gated. Depends on the
 * global DbModule for the raw SQLite handle (DB_HOLDER) it snapshots and swaps.
 */
@Module({
  imports: [AuditModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
