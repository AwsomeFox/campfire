import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { InventoryService } from './inventory.service';
import { CampaignInventoryController, CampaignTreasuryController, InventoryController } from './inventory.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignInventoryController, CampaignTreasuryController, InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
