import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { CharactersModule } from '../characters/characters.module';
import { EncountersModule } from '../encounters/encounters.module';
import { MapsModule } from '../maps/maps.module';
import { SampleEncounterService } from './sample-encounter.service';
import { SampleEncounterController } from './sample-encounter.controller';

/** "Try a sample fight" one-click demo seed (issue #1932) — REST + shared service for the MCP tool. */
@Module({
  imports: [RoleAccessModule, CharactersModule, EncountersModule, MapsModule],
  controllers: [SampleEncounterController],
  providers: [SampleEncounterService],
  exports: [SampleEncounterService],
})
export class SampleEncounterModule {}
