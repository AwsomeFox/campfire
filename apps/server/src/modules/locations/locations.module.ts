import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LocationsService } from './locations.service';
import { CampaignLocationsController, LocationsController } from './locations.controller';

@Module({
  imports: [AuditModule],
  controllers: [CampaignLocationsController, LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
