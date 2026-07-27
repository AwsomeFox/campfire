import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MembershipModule } from '../membership/membership.module';
import { CampaignModulesController, ModuleUpdatesController } from './campaign-modules.controller';
import { CampaignModulesService } from './campaign-modules.service';

/** Campaign modules — package identity, lineage, updates, overlays, rollback (issue #585). */
@Module({
  imports: [AuditModule, MembershipModule],
  controllers: [CampaignModulesController, ModuleUpdatesController],
  providers: [CampaignModulesService],
  exports: [CampaignModulesService],
})
export class CampaignModulesModule {}
