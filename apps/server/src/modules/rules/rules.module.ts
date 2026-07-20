import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { RulesService } from './rules.service';
import { RulesController } from './rules.controller';

@Module({
  // RoleAccessModule provides RoleResolver — the install endpoints gate on
  // "server admin OR DM of any campaign" (issue #20), which needs isDmOfAnyCampaign.
  imports: [AuditModule, RoleAccessModule],
  controllers: [RulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
