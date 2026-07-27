import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminCatalogController } from './admin-catalog.controller';
import { CampaignCatalogController } from './campaign-catalog.controller';

/**
 * Server-admin campaign metadata catalog (issue #587).
 *
 * A LEAF module by design: it imports audit, role access, settings and events, and
 * depends on no DOMAIN module — not campaigns, not quests, not notes, not attachments,
 * not export. That is not an accident of layering, it is the feature's central safety
 * property expressed as a dependency graph. A catalog that cannot inject QuestsService
 * or ExportService cannot accidentally grow a route that leaks one, and a reviewer can
 * confirm the containment by reading this file rather than by auditing every query.
 *
 * WHY EventsModule IS ON THAT LIST AND MembershipModule IS NOT. The line the docblock
 * draws is "no module that can reach campaign CONTENT", not "no imports". EventsModule
 * is infrastructure of the same kind as AuditModule: a fan-out bus whose only dependency
 * is RoleAccessModule, which this module already imports. It carries no content and
 * opens no route to any. It is here because the bulk path writes membership rows
 * directly and therefore owes the same `membership.updated` announcement MembersService
 * makes, so a promoted owner's open tabs stop rendering player-only navigation.
 *
 * MembershipModule would have been the other way to get that, and it is refused: it
 * pulls Auth, Events, Users, Settings and Notifications behind it, trading the guarantee
 * this file exists to make for the reuse of one emit. The same reasoning refused it for
 * the invite precondition — see `validateBulkArgs`.
 *
 * The two controllers are the two halves of the same bargain: AdminCatalogController is
 * what a server operator may see and do, CampaignCatalogController is the campaign's own
 * control over being seen.
 */
@Module({
  imports: [AuditModule, EventsModule, RoleAccessModule, SettingsModule],
  controllers: [AdminCatalogController, CampaignCatalogController],
  providers: [AdminCatalogService],
  exports: [AdminCatalogService],
})
export class AdminCatalogModule {}
