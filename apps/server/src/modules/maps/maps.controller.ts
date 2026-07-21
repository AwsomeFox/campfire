import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { EncountersService } from '../encounters/encounters.service';
import { MapsService } from './maps.service';
import { GenerateMapDto } from './maps.dto';

@ApiTags('maps')
@Controller('campaigns/:campaignId/maps')
export class CampaignMapsController {
  constructor(
    private readonly maps: MapsService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Generate a battle map procedurally and save it as a hidden 'map' attachment (issue
   * #306). dm-only. Creating an attachment is a write, so — like every other write — a
   * read-only / propose-mode token is rejected by the global WriteModeGuard; the map lands
   * hidden (DM-only) so it never leaks to players (#97/#259) until revealed. Returns the
   * new attachmentId, the seed (for reproduction), and the grid config to apply.
   */
  @Post('generate')
  @ApiOperation({
    summary: 'Generate a procedural battle map',
    description:
      'dm role required. Deterministic, offline, license-clean procedural generator (issue #306). Produces a ' +
      'grid-aligned SVG saved as a hidden attachment (kind=map). Pass a `seed` to reproduce a map exactly; omit it ' +
      'and the server returns the seed it chose. Does not attach to any encounter — use POST /encounters/:id/generate-map for that.',
  })
  @ApiResponse({ status: 201, description: 'attachmentId + seed + gridConfig for the generated map.' })
  @ApiResponse({ status: 413, description: 'Generation would exceed the campaign storage quota.' })
  async generate(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: GenerateMapDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.maps.generateForCampaign(campaignId, body, user, role);
  }
}

@ApiTags('maps')
@Controller('encounters/:id')
export class EncounterMapController {
  constructor(
    private readonly maps: MapsService,
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Convenience: generate a map, save it hidden, AND set it as this encounter's battle map
   * with an aligned grid, in one call (issue #306). dm-only. The attachment stays hidden
   * (#259) — the fogged canvas still renders it, but it never appears raw on the player
   * Handouts card.
   */
  @Post('generate-map')
  @ApiOperation({
    summary: "Generate a battle map and attach it to this encounter",
    description:
      'dm role required. Generates a procedural map (issue #306), saves it as a hidden attachment, sets it as the ' +
      "encounter's mapAttachmentId, and aligns the VTT grid — all in one call. Returns attachmentId + seed + gridConfig.",
  })
  @ApiResponse({ status: 201, description: 'attachmentId + seed + gridConfig; the encounter now uses the map.' })
  @ApiResponse({ status: 413, description: 'Generation would exceed the campaign storage quota.' })
  async generateForEncounter(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: GenerateMapDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.maps.generateForEncounter(id, row.campaignId, body, user, role);
  }
}
