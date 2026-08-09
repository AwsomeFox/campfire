import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { MembershipModule } from '../membership/membership.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { RulesService } from './rules.service';
import { CampaignHomebrewController, RulesController } from './rules.controller';

@Module({
  // All rule-pack mutations are server-admin only (issue #736): packs are server-wide, so
  // mutating one affects every campaign — enforced via @ServerRoles('admin') on the
  // controller, which needs no extra providers beyond AuditModule (install/uninstall audit).
  // EventsModule (issue #2097 review): rewriting a rule entry's `dataJson` changes what a
  // no-snapshot equipped item derives on the next read, so this service announces it — see
  // `RulesService.announceEntryChange`.
  imports: [AuditModule, EventsModule, MembershipModule, ProposalRecordsModule],
  controllers: [RulesController, CampaignHomebrewController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
