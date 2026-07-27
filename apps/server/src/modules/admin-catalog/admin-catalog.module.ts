import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminCatalogController } from './admin-catalog.controller';
import { CampaignCatalogController } from './campaign-catalog.controller';

/**
 * Server-admin campaign metadata catalog (issue #587).
 *
 * A LEAF module by design: it imports audit, role access and settings, and depends on
 * no domain module — not campaigns, not quests, not notes, not attachments, not export.
 * That is not an accident of layering, it is the feature's central safety property
 * expressed as a dependency graph. A catalog that cannot inject QuestsService or
 * ExportService cannot accidentally grow a route that leaks one, and a reviewer can
 * confirm the containment by reading this file rather than by auditing every query.
 *
 * The two controllers are the two halves of the same bargain: AdminCatalogController is
 * what a server operator may see and do, CampaignCatalogController is the campaign's own
 * control over being seen.
 */
@Module({
  imports: [AuditModule, RoleAccessModule, SettingsModule],
  controllers: [AdminCatalogController, CampaignCatalogController],
  providers: [AdminCatalogService],
  exports: [AdminCatalogService],
})
export class AdminCatalogModule {}
