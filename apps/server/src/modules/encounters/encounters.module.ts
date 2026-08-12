import { forwardRef, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { EventsModule } from '../events/events.module';
import { RollsModule } from '../rolls/rolls.module';
import { RevisionsModule } from '../revisions/revisions.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { CampaignLibraryModule } from '../campaign-library/campaign-library.module';
import { TableSafetyModule } from '../safety/table-safety.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CharactersModule } from '../characters/characters.module';
import { InventoryModule } from '../inventory/inventory.module';
import { QuestsModule } from '../quests/quests.module';
import { StorylinesModule } from '../storylines/storylines.module';
import { TimelineModule } from '../timeline/timeline.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { EncountersService } from './encounters.service';
import { EncounterMapService } from './encounter-map.service';
import { ActionResolverService } from './action-resolver.service';
import { EncounterPresenceService } from './encounter-presence.service';
import { CampaignEncountersController, CampaignRollController, EncountersController } from './encounters.controller';

@Module({
  imports: [
    AuditModule,
    RoleAccessModule,
    EventsModule,
    RollsModule,
    RevisionsModule,
    AttachmentsModule,
    CampaignLibraryModule,
    // #599 — turn advancement is gated on the table safety hold.
    TableSafetyModule,
    NotificationsModule,
    CharactersModule,
    InventoryModule,
    StorylinesModule,
    TimelineModule,
    forwardRef(() => QuestsModule),
    forwardRef(() => CampaignsModule),
  ],
  controllers: [CampaignEncountersController, CampaignRollController, EncountersController],
  providers: [EncountersService, EncounterMapService, ActionResolverService, EncounterPresenceService],
  // EncounterMapService is exported so the public cast capability (issue #547) can
  // serve the SAME fog-rendered, viewer-role map bytes without going through the
  // membership-authenticated /encounters/:id/map route.
  exports: [EncountersService, EncounterMapService, ActionResolverService],
})
export class EncountersModule {}
