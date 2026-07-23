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
import { CampaignsService } from './campaigns.service';
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
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
