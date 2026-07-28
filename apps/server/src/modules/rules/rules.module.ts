import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MembershipModule } from '../membership/membership.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { RulesService } from './rules.service';
import { CampaignHomebrewController, RulesController } from './rules.controller';

@Module({
  // All rule-pack mutations are server-admin only (issue #736): packs are server-wide, so
  // mutating one affects every campaign — enforced via @ServerRoles('admin') on the
  // controller, which needs no extra providers beyond AuditModule (install/uninstall audit).
  imports: [AuditModule, MembershipModule, ProposalRecordsModule],
  controllers: [RulesController, CampaignHomebrewController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
