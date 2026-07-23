import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { AiDmModule } from '../ai-dm/ai-dm.module';
import { McpModule } from '../mcp/mcp.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { SessionZeroModule } from '../session-zero/session-zero.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { RulesModule } from '../rules/rules.module';
import { AiDriverService } from './ai-driver.service';
import { AiDriverController } from './ai-driver.controller';
import { AiDmStreamService } from './ai-driver-stream.service';
import { AI_PROVIDER_RESOLVER, ConfigAiProviderResolver } from './ai-provider-resolver';

/**
 * Driver AI-DM runtime (#312) — the session loop that turns the AI DM seat into a
 * live, streaming, tool-executing Dungeon Master. Composes the three AI foundations:
 *   - AiDmModule           — seat gating + atomic budget metering (#28/#272).
 *   - McpModule            — the FULL executable tool registry (buildToolset).
 *   - AiProviderConfigModule — resolveEffectiveConfig (#310) → createAiProvider (#309),
 *                              wired through the ConfigAiProviderResolver seam below.
 *
 * EventsModule is imported so the narration SSE stream can watch the shared
 * CampaignEventsService for `membership.revoked` and tear down a removed member's
 * open stream (issue #527) — the AI narration channel is a separate Subject but
 * shares the same single-check-at-open authorization drift as the campaign event
 * stream otherwise.
 *
 * AI_PROVIDER_RESOLVER is a DI token so tests (#318 harness) can swap in a resolver
 * that returns the deterministic mock provider — the whole loop then runs offline.
 *
 * CampaignsModule + RulesModule feed the #717 campaign-scoped rules-lookup lever: the
 * driver resolves the campaign's active rule system (ruleSystem slug → RulePack) and
 * scopes compendium search to that single pack.
 */
@Module({
  imports: [
    AuditModule,
    EventsModule,
    RoleAccessModule,
    AiDmModule,
    McpModule,
    NotificationsModule,
    AiProviderConfigModule,
    SessionZeroModule,
    CampaignsModule,
    RulesModule,
  ],
  controllers: [AiDriverController],
  providers: [
    AiDriverService,
    AiDmStreamService,
    { provide: AI_PROVIDER_RESOLVER, useClass: ConfigAiProviderResolver },
  ],
  exports: [AiDriverService, AiDmStreamService],
})
export class AiDriverModule {}
