import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { MembershipModule } from '../membership/membership.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { QuestsModule } from '../quests/quests.module';
import { StorylinesModule } from '../storylines/storylines.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CharactersModule } from '../characters/characters.module';
import { NotesModule } from '../notes/notes.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { RulesModule } from '../rules/rules.module';
import { EncountersModule } from '../encounters/encounters.module';
import { AuditModule } from '../audit/audit.module';
import { ExportModule } from '../export/export.module';
import { AiDmModule } from '../ai-dm/ai-dm.module';
import { SessionZeroModule } from '../session-zero/session-zero.module';
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
    LocationsModule,
    SessionsModule,
    CharactersModule,
    NotesModule,
    ProposalRecordsModule,
    ProposalsModule,
    RulesModule,
    EncountersModule,
    AuditModule,
    ExportModule,
    AiDmModule,
    SessionZeroModule,
  ],
  controllers: [McpController],
  providers: [McpToolsService],
})
export class McpModule {}
