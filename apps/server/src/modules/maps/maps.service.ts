import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { GenerateMapParams, GeneratedMapResult, Role } from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
import { AttachmentsService } from '../attachments/attachments.service';
import { EncountersService } from '../encounters/encounters.service';
import { generateMap } from './map-generator';

/** Content type + on-disk format for every generated map (see AttachmentsService.filePath). */
const MAP_MIME = 'image/svg+xml';

/**
 * Procedural battle-map generation (issue #306). Wires the pure, deterministic generator
 * (map-generator.ts) into the existing attachment + encounter machinery:
 *  - the SVG is saved as a normal attachment (kind='map'), so it flows through the VTT
 *    grid/fog (#40) and handout-visibility (#97/#259) pipeline unchanged, and lands hidden
 *    (DM-only) by default so a prepped map never auto-reveals to players;
 *  - the encounter convenience path additionally attaches the map + aligns the grid in one
 *    call via EncountersService.updateEncounter (which validates the ref, does NOT reveal
 *    the attachment, and audits the change).
 *
 * Fully offline/deterministic: no external network calls. The RNG seed is explicit — when
 * the caller omits `seed` we mint one from crypto (never Math.random) and return it, so the
 * exact map is always reproducible.
 */
@Injectable()
export class MapsService {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly encounters: EncountersService,
  ) {}

  /** Resolve the seed (caller's, or a fresh crypto-random one) and run the generator. */
  private render(params: GenerateMapParams) {
    const seed = params.seed ?? crypto.randomBytes(8).toString('hex');
    return generateMap({
      kind: params.kind,
      size: params.size,
      seed,
      complexity: params.complexity,
      theme: params.theme,
      gridScale: params.gridScale,
      gridUnit: params.gridUnit,
    });
  }

  /**
   * Generate a map for a campaign and save it as a hidden 'map' attachment. Returns the
   * new attachment id + the seed (for reproduction) + the grid geometry the caller can
   * apply to an encounter. Does not touch any encounter — that's the convenience path.
   */
  async generateForCampaign(
    campaignId: number,
    params: GenerateMapParams,
    user: RequestUser,
    role: Role,
  ): Promise<GeneratedMapResult> {
    const map = this.render(params);
    const filename = `${map.kind}-${map.seed}.svg`;
    const attachment = await this.attachments.createGenerated(
      campaignId,
      'map',
      { filename, mime: MAP_MIME, bytes: Buffer.from(map.svg, 'utf8') },
      user,
      role,
    );
    return {
      attachmentId: attachment.id,
      seed: map.seed,
      kind: map.kind,
      widthCells: map.widthCells,
      heightCells: map.heightCells,
      roomCount: map.roomCount,
      gridConfig: map.gridConfig,
    };
  }

  /**
   * Generate a map, save it as a hidden attachment, and set it as the encounter's battle
   * map with an aligned grid — all in one call. The attachment stays hidden (issue #259:
   * a battle map is a handout that must not surface raw on the player Handouts card; the
   * fogged canvas still renders it via the file route's encounter-map exception).
   */
  async generateForEncounter(
    encounterId: number,
    campaignId: number,
    params: GenerateMapParams,
    user: RequestUser,
    role: Role,
  ): Promise<GeneratedMapResult> {
    const result = await this.generateForCampaign(campaignId, params, user, role);
    await this.encounters.updateEncounter(
      encounterId,
      {
        mapAttachmentId: result.attachmentId,
        gridSize: result.gridConfig.gridSize,
        gridScale: result.gridConfig.gridScale,
        gridUnit: result.gridConfig.gridUnit,
        gridType: result.gridConfig.gridType,
      },
      user,
      role,
    );
    return result;
  }
}
