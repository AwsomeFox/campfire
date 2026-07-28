import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DataRepairModule } from '../data-repair/data-repair.module';

@Module({
  imports: [DataRepairModule],
  controllers: [HealthController],
})
export class HealthModule {}
