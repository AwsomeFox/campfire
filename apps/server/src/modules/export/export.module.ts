import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { MembershipModule } from '../membership/membership.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CharactersModule } from '../characters/characters.module';
import { NotesModule } from '../notes/notes.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { EncountersModule } from '../encounters/encounters.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { FactionsModule } from '../factions/factions.module';
import { StorylinesModule } from '../storylines/storylines.module';
import { TimelineModule } from '../timeline/timeline.module';
import { SessionZeroModule } from '../session-zero/session-zero.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CommentsModule } from '../comments/comments.module';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';

@Module({
  imports: [
    AuditModule,
    RoleAccessModule,
    MembershipModule,
    CampaignsModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    SessionsModule,
    CharactersModule,
    NotesModule,
    ProposalsModule,
    EncountersModule,
    AttachmentsModule,
    FactionsModule,
    StorylinesModule,
    TimelineModule,
    SessionZeroModule,
    InventoryModule,
    CommentsModule,
  ],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
