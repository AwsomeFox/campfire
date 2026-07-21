import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { AiConsoleService } from './ai-console.service';
import { AiConsoleController } from './ai-console.controller';

/**
 * Admin AI console (issue #315) — the server-admin cockpit over the AI program
 * (epic #308): global kill switch, server + per-campaign token caps, a usage
 * dashboard aggregated LIVE from the existing per-seat metering (no new ledger
 * table), the #310 model-allowlist editor, and a provider-health "test all".
 *
 * Read/aggregate + admin-write layer only — it reuses SettingsService (the kill
 * switch flag + server cap), AiProviderConfigService (allowlist + provider
 * health), and AuditService. Budget ENFORCEMENT lives where the spend happens
 * (AiDmService); this module surfaces and configures it.
 */
@Module({
  imports: [AuditModule, SettingsModule, AiProviderConfigModule],
  controllers: [AiConsoleController],
  providers: [AiConsoleService],
  exports: [AiConsoleService],
})
export class AiConsoleModule {}
