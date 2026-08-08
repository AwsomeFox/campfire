import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { CharactersModule } from '../characters/characters.module';
import { SessionsModule } from '../sessions/sessions.module';
import { MembershipModule } from '../membership/membership.module';
import { EncountersModule } from '../encounters/encounters.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TimelineModule } from '../timeline/timeline.module';
import { CommentsModule } from '../comments/comments.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { EventsModule } from '../events/events.module';
import { AiDmModule } from '../ai-dm/ai-dm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { CampaignsService } from './campaigns.service';
import { CampaignGovernanceService } from './campaign-governance.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [
    AuditModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    CharactersModule,
    SessionsModule,
    MembershipModule,
    EncountersModule,
    InventoryModule,
    TimelineModule,
    CommentsModule,
    AttachmentsModule,
    EventsModule,
    // #1049: clone/import write the AI seat row directly, then call
    // AiDmService.syncProactiveWatcher so the in-memory proactive watcher learns about it.
    AiDmModule,
    // Issue #1707: trash() sends an account-wide `campaign_trashed` notification (the
    // same backstop channel #1653/#1640 built for membership revocation), mirroring
    // MembersService.remove() — a leaf module, safe to import directly (no cycle).
    NotificationsModule,
    // Issue #851: shared-instance governance (policy/limits/default quota) reads
    // server settings. SettingsModule is a leaf module (only DbModule), so this
    // creates no cycle.
    SettingsModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignGovernanceService],
  exports: [CampaignsService, CampaignGovernanceService],
})
export class CampaignsModule {}
