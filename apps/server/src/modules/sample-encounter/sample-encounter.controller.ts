import { Controller, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SampleEncounterService } from './sample-encounter.service';

@ApiTags('encounters')
@Controller('campaigns/:campaignId/sample-encounter')
export class SampleEncounterController {
  constructor(
    private readonly sampleEncounter: SampleEncounterService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Seed a one-click sample fight (issue #1932)',
    description:
      'dm role required. Seeds, inside this campaign, 4 pregen characters (active, unowned — ' +
      'players can claim them later), one `preparing` encounter ("Sample Fight") with 4 bandits ' +
      'added via the inline-statblock path (no rule pack required), and a generated, grid-aligned ' +
      'battle map — fully offline, through the same write paths as create_character/create_encounter/' +
      'add_combatant/generate_map_for_encounter. Safe to click again: a second call never overwrites ' +
      'the first — it mints "Sample Fight 2", "Sample Fight 3", etc.',
  })
  @ApiResponse({ status: 201, description: 'Ids of everything the seed created.' })
  @ApiResponse({ status: 403, description: 'Requires the dm role; refused on an archived campaign.' })
  async seed(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.sampleEncounter.seed(campaignId, user, role);
  }
}
