import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { SessionZeroModule } from '../session-zero/session-zero.module';
import { TableSafetyService } from './table-safety.service';
import { TableSafetyController } from './table-safety.controller';

/**
 * Table safety hold / X-Card (issue #599).
 *
 * Deliberately DOWNSTREAM of everything and upstream of nothing that matters: it imports only
 * leaf-ish infrastructure (audit, events, notifications, role access) plus the session-zero
 * charter it appends veils to. It does NOT import EncountersModule or AiDriverModule, even
 * though both consume it — those modules import this one, and the AI driver reaches back in
 * through a registered callback rather than a DI edge.
 *
 * That direction is not a style preference. The safety hold has to be reachable from the
 * lowest layers of the app (encounter turn advancement) and from the highest (the AI session
 * loop). If it depended on either, it could not be depended on by the other without a
 * forwardRef, and a forwardRef cycle around the one code path that must never fail to
 * initialise is a bad trade.
 */
@Module({
  imports: [AuditModule, EventsModule, NotificationsModule, RoleAccessModule, SessionZeroModule],
  controllers: [TableSafetyController],
  providers: [TableSafetyService],
  exports: [TableSafetyService],
})
export class TableSafetyModule {}
