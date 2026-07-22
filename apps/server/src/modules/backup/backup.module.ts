import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';

/**
 * Whole-server backup & restore (issue #21). Server-admin gated. Depends on the
 * global DbModule for the raw SQLite handle (DB_HOLDER) it snapshots and swaps,
 * and on SettingsModule to persist the scheduled-backup cadence state
 * (lastBackupAt / nextRunAt) introduced in issue #732.
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
