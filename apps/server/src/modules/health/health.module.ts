import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { StorageDiagnosticsService } from './storage-diagnostics.service';

@Module({
  controllers: [HealthController],
  providers: [StorageDiagnosticsService],
  exports: [StorageDiagnosticsService],
})
export class HealthModule {}
