import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { CampaignLibraryService } from './campaign-library.service';
import { CampaignLibraryController, CampaignLibrarySearchController, CampaignLibraryTaxonomyController, LibraryMonstersController } from './campaign-library.controller';

@Module({
  imports: [AuditModule, EventsModule, RoleAccessModule],
  controllers: [CampaignLibraryController, CampaignLibrarySearchController, CampaignLibraryTaxonomyController, LibraryMonstersController],
  providers: [CampaignLibraryService],
  exports: [CampaignLibraryService],
})
export class CampaignLibraryModule {}
