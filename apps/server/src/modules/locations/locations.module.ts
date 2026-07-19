import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { LocationsService } from './locations.service';
import { CampaignLocationsController, LocationsController } from './locations.controller';

@Module({
  imports: [AuditModule, RoleAccessModule, ProposalRecordsModule],
  controllers: [CampaignLocationsController, LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
