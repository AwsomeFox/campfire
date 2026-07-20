import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { SessionZeroService } from './session-zero.service';
import { SessionZeroController } from './session-zero.controller';

// Session zero / table charter (issue #122) — a per-campaign safety & expectations
// record (lines & veils, safety tools, house rules, tone). Exported so the MCP module
// can expose it read-only to a connected AI DM.
@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [SessionZeroController],
  providers: [SessionZeroService],
  exports: [SessionZeroService],
})
export class SessionZeroModule {}
