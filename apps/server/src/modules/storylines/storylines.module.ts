import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { StorylinesService } from './storylines.service';
import { CampaignArcsController, ArcsController, BeatsController } from './storylines.controller';

/** Storylines (issue #27): DM-only branching arc/beat/branch planner. */
@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignArcsController, ArcsController, BeatsController],
  providers: [StorylinesService],
  exports: [StorylinesService],
})
export class StorylinesModule {}
