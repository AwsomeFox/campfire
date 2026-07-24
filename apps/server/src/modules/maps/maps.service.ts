import crypto from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  Attachment,
  GenerateMapParams,
  GeneratedMapPreview,
  GeneratedMapResult,
  ImportMapAttribution,
  MapSource,
  Role,
} from '@campfire/schema';
import { isOpenLicense, licenseForbidsRedistribution } from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
import { AttachmentsService, sniffImageMime } from '../attachments/attachments.service';
import { EncountersService } from '../encounters/encounters.service';
import { generateMap } from './map-generator';
import { OPEN_MAP_SOURCES } from './map-sources';

/** Content type + on-disk format for every generated map (see AttachmentsService.filePath). */
const MAP_MIME = 'image/svg+xml';

/** Result of an attributed import: the stored map attachment plus the credit stamped onto it. */
export interface ImportedMapResult {
  attachment: Attachment;
  attribution: { title: string; author: string; license: string; sourceUrl?: string };
}

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
   * Render a candidate map WITHOUT persisting it (issue #409). This backs the web
   * generation wizard's preview/reroll: the DM sees the SVG (and can reroll the seed)
   * before committing, and because nothing is written, previewing/rerolling never leaves
   * orphan attachments or consumes the campaign's storage quota. "Use this map" then
   * replays the returned seed through generateForCampaign/generateForEncounter to attach
   * the exact same map (generation is deterministic by seed). Read-only: no DB/disk write.
   */
  previewForCampaign(params: GenerateMapParams): GeneratedMapPreview {
    const map = this.render(params);
    return {
      svg: map.svg,
      seed: map.seed,
      kind: map.kind,
      widthCells: map.widthCells,
      heightCells: map.heightCells,
      roomCount: map.roomCount,
      gridConfig: map.gridConfig,
    };
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
      // Audit records actor/source/seed (issue #409): the actor + role come from the
      // audit row's actor columns; this detail names the first-party generator as the
      // source and the exact seed, so a generated map is always attributable and
      // reproducible from the audit trail alone.
      `map:generator-builtin:seed=${map.seed}`,
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

  /**
   * The curated catalog of open, license-clean external map sources (issue #303) — the
   * data behind the DM's "get a map" affordance. Static and offline: generator entries are
   * links the DM runs client-side (Watabou, donjon), plus the built-in generator (#306) and
   * the One Page Dungeon Contest (CC-BY-SA), which is importable via importAttributedMap.
   */
  listSources(): readonly MapSource[] {
    return OPEN_MAP_SOURCES;
  }

  /**
   * Import an open-licensed external map (issue #303) — e.g. a One Page Dungeon Contest
   * entry (CC-BY-SA 3.0) the DM downloaded, or a Watabou/donjon export. Saves it as a
   * hidden (#97/#259) 'map' attachment so it never auto-leaks to players, with the required
   * attribution stamped onto the stored filename so the credit travels with the artifact.
   *
   * License-clean by construction:
   *  - the claimed licence is validated against `isOpenLicense` (the same gate that rejects
   *    NC/ND rule packs, #19), so a proprietary/NC/ND map is refused with a 400 — we don't
   *    weaken the gate;
   *  - the bytes are sniffed (magic-byte) and must be a real png/jpeg/webp image, exactly
   *    like a normal upload, so a mislabelled or non-image file can't be stored as a map.
   */
  async importAttributedMap(
    campaignId: number,
    attribution: ImportMapAttribution,
    file: { buffer: Buffer },
    user: RequestUser,
    role: Role,
  ): Promise<ImportedMapResult> {
    // Two layers, because importing re-serves the bytes to the whole table:
    //  1. must NAME an open licence (the #19 gate), and
    //  2. must NOT carry an NC/ND restriction. Layer 2 is essential here and not redundant:
    //     `isOpenLicense` is a permissive substring match, so "CC-BY-NC-ND" sneaks past it on
    //     the "cc-by" substring — yet NC/ND is exactly the 'free map' pack licence Campfire
    //     may not redistribute (issue #303). We reject those explicitly rather than weakening
    //     the shared gate.
    if (!isOpenLicense(attribution.license) || licenseForbidsRedistribution(attribution.license)) {
      throw new BadRequestException(
        `Refusing to import a map under the licence "${attribution.license}". ` +
          'Only openly-redistributable content (e.g. CC-BY-SA, CC-BY, CC0, OGL) can be imported — ' +
          "non-commercial (NC) or no-derivatives (ND) 'free map' packs can't be re-served.",
      );
    }

    const mime = sniffImageMime(file.buffer);
    if (!mime) {
      throw new BadRequestException(
        'Imported map is not a supported image — allowed: image/png, image/jpeg, image/webp.',
      );
    }

    // Stamp the attribution onto the filename so the CC-BY-SA credit is carried by the
    // artifact itself (surfaces in the attachment list + Content-Disposition). Kept within
    // the 255-char column via createGenerated's own slice.
    const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
    const filename = sanitizeFilename(
      `${attribution.title} — ${attribution.author} (${attribution.license})`,
    ).slice(0, 240) + `.${ext}`;

    const attachment = await this.attachments.createGenerated(
      campaignId,
      'map',
      { filename, mime, bytes: file.buffer },
      user,
      role,
    );

    return {
      attachment,
      attribution: {
        title: attribution.title,
        author: attribution.author,
        license: attribution.license,
        sourceUrl: attribution.sourceUrl,
      },
    };
  }
}

/** Collapse newlines/slashes/control chars so an attribution string is a safe single-line filename. */
function sanitizeFilename(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[ -/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}
