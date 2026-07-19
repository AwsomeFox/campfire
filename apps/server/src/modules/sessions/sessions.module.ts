import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionsService } from './sessions.service';
import { CampaignSessionsController, SessionsController } from './sessions.controller';

@Module({
  imports: [AuditModule],
  controllers: [CampaignSessionsController, SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
