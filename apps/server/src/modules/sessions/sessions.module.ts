import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { SessionsService } from './sessions.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignSessionsController, SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
