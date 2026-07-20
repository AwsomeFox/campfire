import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { RollsService } from './rolls.service';
import { CampaignRollsController } from './rolls.controller';

@Module({
  imports: [RoleAccessModule],
  controllers: [CampaignRollsController],
  providers: [RollsService],
  exports: [RollsService],
})
export class RollsModule {}
