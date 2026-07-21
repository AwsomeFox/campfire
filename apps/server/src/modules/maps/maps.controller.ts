import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { EncountersService } from '../encounters/encounters.service';
import { MAX_UPLOAD_BYTES } from '../attachments/attachments.service';
import { MapsService } from './maps.service';
import { GenerateMapDto, ImportMapDto } from './maps.dto';

// Express.Multer.File augments the Express namespace via @types/multer; import side-effect only.
type MulterFile = Express.Multer.File;

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
  /**
   * The curated catalog of open, license-clean external map sources (issue #303) — the
   * data behind the DM's "get a map" affordance. Any campaign member may read it (it is
   * static reference data, not campaign content). Lists map *generators* the DM runs
   * client-side (Watabou, donjon), the built-in generator (#306), and the One Page Dungeon
   * Contest (CC-BY-SA), which is importable via POST .../maps/import.
   */
  @Get('sources')
  @ApiOperation({
    summary: 'List open, license-clean map sources',
    description:
      'Requires membership. Curated catalog (issue #303) of external map generators (Watabou, donjon), the built-in ' +
      'procedural generator (#306), and the One Page Dungeon Contest (CC-BY-SA 3.0, importable). Nothing here is ' +
      "bundled/re-served — NC/ND 'free map' packs are intentionally excluded.",
  })
  @ApiResponse({ status: 200, description: 'The curated open map-source catalog.' })
  async sources(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMember(user, campaignId);
    return this.maps.listSources();
  }

  /**
   * Import an open-licensed external map the DM downloaded (issue #303) — e.g. a One Page
   * Dungeon Contest entry (CC-BY-SA 3.0), or a Watabou/donjon export. dm-only. Multipart:
   * the image `file` plus attribution fields (title, author, license, sourceUrl). Saved as a
   * hidden (DM-only, #97/#259) 'map' attachment with the credit stamped onto the filename.
   * The claimed licence is validated against the open-licence gate (#19) — a non-commercial /
   * no-derivatives pack is rejected with a 400 (the gate is not weakened).
   */
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Import an open-licensed external map with attribution',
    description:
      'dm role required. Multipart upload of an open-licensed map image (png/jpeg/webp) plus attribution (title, ' +
      'author, license, sourceUrl). The licence must pass the open-licence gate (CC-BY-SA/CC-BY/CC0/OGL/…); NC/ND ' +
      "content is rejected. The map lands hidden (DM-only) with the CC-BY-SA credit stamped onto its filename.",
  })
  @ApiResponse({ status: 201, description: 'The imported map attachment + the stamped attribution.' })
  @ApiResponse({ status: 400, description: 'Missing file, non-image bytes, or a non-open licence.' })
  @ApiResponse({ status: 413, description: 'Import would exceed the campaign storage quota, or the file is too large.' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      // MemoryStorage (no `storage` option) so the service sees file.buffer for the
      // magic-byte sniff — the on-disk bytes are written by AttachmentsService, keyed by id.
    }),
  )
  async import(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @UploadedFile() file: MulterFile | undefined,
    @Body() body: ImportMapDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw new BadRequestException('Missing file (multipart field "file")');
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.maps.importAttributedMap(campaignId, body, { buffer: file.buffer }, user, role);
  }

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
