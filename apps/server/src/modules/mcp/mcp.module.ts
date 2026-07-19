import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CharactersModule } from '../characters/characters.module';
import { NotesModule } from '../notes/notes.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { McpToolsService } from './mcp-tools';
import { McpController } from './mcp.controller';

/** MCP (Model Context Protocol) Streamable HTTP endpoint — see McpController. */
@Module({
  imports: [
    RoleAccessModule,
    CampaignsModule,
    QuestsModule,
    NpcsModule,
    LocationsModule,
    SessionsModule,
    CharactersModule,
    NotesModule,
    ProposalRecordsModule,
    ProposalsModule,
  ],
  controllers: [McpController],
  providers: [McpToolsService],
})
export class McpModule {}
