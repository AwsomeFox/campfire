import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AiPricingService } from './ai-pricing.service';

/**
 * Server-wide AI model pricing (issue #1065).
 *
 * Its own module, and a deliberately tiny one, because BOTH ends of the app need it and they
 * sit on opposite sides of an existing dependency edge: `AiDmService` prices a campaign's
 * readiness estimate, while the admin console owns the editor — and `AiConsoleModule` already
 * imports `AiDriverModule`, so hosting pricing in the console and importing it from the AI-DM
 * side would close a cycle. Depending only on `SettingsModule` keeps this a leaf that anyone
 * may import.
 */
@Module({
  imports: [SettingsModule],
  providers: [AiPricingService],
  exports: [AiPricingService],
})
export class AiPricingModule {}
