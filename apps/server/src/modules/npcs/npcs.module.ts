import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { NpcsService } from './npcs.service';
import { CampaignNpcsController, NpcsController } from './npcs.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignNpcsController, NpcsController],
  providers: [NpcsService],
  exports: [NpcsService],
})
export class NpcsModule {}
