import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CharactersService } from './characters.service';
import { CampaignCharactersController, CharactersController } from './characters.controller';

@Module({
  imports: [AuditModule],
  controllers: [CampaignCharactersController, CharactersController],
  providers: [CharactersService],
  exports: [CharactersService],
})
export class CharactersModule {}
