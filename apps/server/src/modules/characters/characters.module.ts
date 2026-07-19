import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { CharactersService } from './characters.service';
import { CampaignCharactersController, CharactersController } from './characters.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [CampaignCharactersController, CharactersController],
  providers: [CharactersService],
  exports: [CharactersService],
})
export class CharactersModule {}
