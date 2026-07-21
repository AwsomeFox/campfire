import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { EncountersModule } from '../encounters/encounters.module';
import { MapsService } from './maps.service';
import { CampaignMapsController, EncounterMapController } from './maps.controller';

/** Procedural battle-map generation (issue #306) — REST + shared service for the MCP tool. */
@Module({
  imports: [RoleAccessModule, AttachmentsModule, EncountersModule],
  controllers: [CampaignMapsController, EncounterMapController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
