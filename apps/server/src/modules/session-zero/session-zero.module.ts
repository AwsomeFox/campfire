import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { SessionZeroService } from './session-zero.service';
import { SessionZeroController } from './session-zero.controller';
import { SupportPreferencesController } from './support-preferences.controller';
import { SupportPreferencesService } from './support-preferences.service';
import { SessionZeroConsentService } from './session-zero-consent.service';
import { SessionZeroConsentController } from './session-zero-consent.controller';

// Session zero / table charter (issue #122) — a per-campaign safety & expectations
// record (lines & veils, safety tools, house rules, tone). Exported so the MCP module
// can expose it read-only to a connected AI DM.
@Module({
  imports: [AuditModule, RoleAccessModule, RevisionsModule, NotificationsModule],
  controllers: [SessionZeroController, SupportPreferencesController, SessionZeroConsentController],
  providers: [SessionZeroService, SupportPreferencesService, SessionZeroConsentService],
  exports: [SessionZeroService, SupportPreferencesService, SessionZeroConsentService],
})
export class SessionZeroModule {}
