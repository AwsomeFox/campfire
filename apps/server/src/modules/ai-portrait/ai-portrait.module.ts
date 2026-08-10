import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { CharactersModule } from '../characters/characters.module';
import { NpcsModule } from '../npcs/npcs.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { AiPortraitController } from './ai-portrait.controller';
import { AiPortraitService } from './ai-portrait.service';

/**
 * AI portrait generation (issue #1321). Mirrors the ai-map (#410) module wiring: the service is
 * exported so MCP tools can inject it alongside the REST controller.
 */
@Module({
  imports: [AuditModule, RoleAccessModule, AttachmentsModule, CharactersModule, NpcsModule, AiProviderConfigModule],
  controllers: [AiPortraitController],
  providers: [AiPortraitService],
  exports: [AiPortraitService],
})
export class AiPortraitModule {}
