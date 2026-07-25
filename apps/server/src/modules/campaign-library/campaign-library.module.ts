import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { CampaignLibraryService } from './campaign-library.service';
import { CampaignLibraryController, LibraryMonstersController } from './campaign-library.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignLibraryController, LibraryMonstersController],
  providers: [CampaignLibraryService],
  exports: [CampaignLibraryService],
})
export class CampaignLibraryModule {}
