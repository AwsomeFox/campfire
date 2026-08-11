import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { CharactersModule } from '../characters/characters.module';
import { NpcsModule } from '../npcs/npcs.module';
import { FactionsModule } from '../factions/factions.module';
import { LocationsModule } from '../locations/locations.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { AiPortraitController } from './ai-portrait.controller';
import { AiPortraitService } from './ai-portrait.service';

/**
 * AI portrait generation (issues #1321, #1325). Mirrors the ai-map (#410) module wiring: the service is
 * exported so MCP tools can inject it alongside the REST controller.
 */
@Module({
  imports: [
    AuditModule,
    RoleAccessModule,
    AttachmentsModule,
    CharactersModule,
    NpcsModule,
    FactionsModule,
    LocationsModule,
    AiProviderConfigModule,
  ],
  controllers: [AiPortraitController],
  providers: [AiPortraitService],
  exports: [AiPortraitService],
})
export class AiPortraitModule {}
