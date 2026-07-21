import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { AiDmService } from './ai-dm.service';
import { AiDmController } from './ai-dm.controller';
import { CoDmService } from './co-dm.service';
import { CoDmController } from './co-dm.controller';
import { AI_DM_PROVIDER, NoopAiDmProvider } from './ai-dm.provider';

/**
 * Experimental server-side AI Dungeon Master (issue #28) — isolated module.
 *
 * AI_DM_PROVIDER is bound to the dependency-free NoopAiDmProvider by default:
 * Campfire ships no server-side LLM and makes no vendor calls. An operator who
 * wants real server-side generation swaps this binding for their own provider
 * (useClass/useFactory) — the metering, gating and audit around it are unchanged.
 */
@Module({
  imports: [AuditModule, SettingsModule, RoleAccessModule, AiProviderConfigModule, ProposalRecordsModule],
  controllers: [AiDmController, CoDmController],
  providers: [AiDmService, CoDmService, { provide: AI_DM_PROVIDER, useClass: NoopAiDmProvider }],
  // AI_DM_PROVIDER is exported so the scribe (#316) shares the SAME injected provider seam.
  exports: [AiDmService, CoDmService, AI_DM_PROVIDER],
})
export class AiDmModule {}
