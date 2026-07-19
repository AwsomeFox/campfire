import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { QuestsService } from './quests.service';
import { CampaignQuestsController, QuestsController } from './quests.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignQuestsController, QuestsController],
  providers: [QuestsService],
  exports: [QuestsService],
})
export class QuestsModule {}
