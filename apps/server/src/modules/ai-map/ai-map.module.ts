import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { EncountersModule } from '../encounters/encounters.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { AiMapService } from './ai-map.service';
import { AiMapController } from './ai-map.controller';

/**
 * Genuine AI map generation (issue #410) — REST + a shared service the MCP tools reuse.
 * Routes a brief through the configured provider honestly (image provider → procedural
 * blueprint → external instructions) and persists a chosen candidate through the existing
 * attachment machinery (hidden by default, DM-only).
 */
@Module({
  imports: [AuditModule, RoleAccessModule, AttachmentsModule, EncountersModule, AiProviderConfigModule],
  controllers: [AiMapController],
  providers: [AiMapService],
  exports: [AiMapService],
})
export class AiMapModule {}
