import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { StorageDiagnosticsService } from './storage-diagnostics.service';
import { DataRepairModule } from '../data-repair/data-repair.module';

@Module({
  imports: [DataRepairModule],
  controllers: [HealthController],
  providers: [StorageDiagnosticsService],
  exports: [StorageDiagnosticsService],
})
export class HealthModule {}
