import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderServerConfigController } from './ai-provider-config.server.controller';
import { AiProviderCampaignConfigController } from './ai-provider-config.campaign.controller';

/**
 * Encrypted AI provider config storage (issue #310) — the credential/config layer
 * for the AI program epic (#308). Persists provider selection + an ENCRYPTED,
 * write-only API key at two scopes (server default + per-campaign override) and
 * exposes `AiProviderConfigService.resolveEffectiveConfig`, which decrypts the key
 * in-process to feed #309's `createAiProvider` (consumed by #312). Reads are always
 * redacted; the key never leaves the server.
 */
@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [AiProviderServerConfigController, AiProviderCampaignConfigController],
  providers: [AiProviderConfigService],
  exports: [AiProviderConfigService],
})
export class AiProviderConfigModule {}
