import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { MembershipModule } from '../membership/membership.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { QuestsModule } from '../quests/quests.module';
import { StorylinesModule } from '../storylines/storylines.module';
import { NpcsModule } from '../npcs/npcs.module';
import { FactionsModule } from '../factions/factions.module';
import { LocationsModule } from '../locations/locations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CharactersModule } from '../characters/characters.module';
import { NotesModule } from '../notes/notes.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { RulesModule } from '../rules/rules.module';
import { EncountersModule } from '../encounters/encounters.module';
import { MapsModule } from '../maps/maps.module';
import { AuditModule } from '../audit/audit.module';
import { ExportModule } from '../export/export.module';
import { AiDmModule } from '../ai-dm/ai-dm.module';
import { ScribeModule } from '../scribe/scribe.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SessionZeroModule } from '../session-zero/session-zero.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TimelineModule } from '../timeline/timeline.module';
import { CommentsModule } from '../comments/comments.module';
import { McpToolsService } from './mcp-tools';
import { McpController } from './mcp.controller';

/** MCP (Model Context Protocol) Streamable HTTP endpoint — see McpController. */
@Module({
  imports: [
    RoleAccessModule,
    MembershipModule,
    CampaignsModule,
    QuestsModule,
    StorylinesModule,
    NpcsModule,
    FactionsModule,
    LocationsModule,
    SessionsModule,
    CharactersModule,
    NotesModule,
    ProposalRecordsModule,
    ProposalsModule,
    RulesModule,
    EncountersModule,
    MapsModule,
    AuditModule,
    ExportModule,
    AiDmModule,
    ScribeModule,
    AttachmentsModule,
    SessionZeroModule,
    InventoryModule,
    TimelineModule,
    CommentsModule,
  ],
  controllers: [McpController],
  providers: [McpToolsService],
  // Exported so the AI driver runtime (#312) can reuse the FULL tool registry
  // (buildToolset) with identical role/write-mode/proposal enforcement.
  exports: [McpToolsService],
})
export class McpModule {}
