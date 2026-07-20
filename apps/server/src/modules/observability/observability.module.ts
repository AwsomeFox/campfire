import { Module } from '@nestjs/common';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';

@Module({
  controllers: [ObservabilityController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
