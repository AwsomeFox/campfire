import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Patch,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { filterHidden } from '../../common/redact';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AttachmentsService, ALLOWED_MIME_TO_EXT, MAX_UPLOAD_BYTES } from './attachments.service';
import { AttachmentMetadataUpdateDto, AttachmentUploadDto } from './attachments.dto';
import { contentDispositionHeader } from './filename';
import {
  DERIVATIVE_VARIANT_NAMES,
  isDerivativeVariantName,
  type RequestedSize,
} from './image-derivatives';

// Express.Multer.File augments the Express namespace via @types/multer; import side-effect only.
type MulterFile = Express.Multer.File;

/**
 * True when an `If-None-Match` request header means the client's cached copy is
 * still current for `etag` — i.e. it is `*` or lists this (strong) etag. Handles
 * the comma-separated multi-value form. Used to answer a revalidation with 304.
 */
function ifNoneMatchSatisfied(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((v) => v.trim())
    .some((v) => v === '*' || v === etag);
}

@ApiTags('attachments')
@Controller('campaigns/:campaignId/attachments')
export class CampaignAttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Multipart upload. `kind` in the form body decides both storage bucket and the
   * minimum role: player+ may upload 'portrait', dm-only for 'map'/'image'. Mime
   * allowlist + size cap are enforced by the FileInterceptor options below;
   * fileFilter rejections surface as 400s (via BadRequestException), size overages
   * as 413s (Multer's LIMIT_FILE_SIZE, translated by Nest's built-in exception filter).
   * The declared mimetype is additionally verified against the actual file bytes
   * (magic-byte sniffing) in AttachmentsService.create — the fileFilter runs before
   * the buffer exists, so content sniffing can't happen there.
   */
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an attachment', description: "Multipart upload. `kind` in the form body selects the bucket and minimum role: player+ for 'portrait', dm-only for 'map'/'image'. Allowed mime types: image/png, image/jpeg, image/webp, application/pdf." })
  @ApiResponse({ status: 201, description: 'Attachment created.' })
  @ApiResponse({ status: 400, description: 'Missing file, unsupported mime type, or file content that does not match the declared type.' })
  @ApiResponse({ status: 413, description: 'File exceeds the max upload size.' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      // No `storage` option -> multer defaults to MemoryStorage, giving us file.buffer
      // directly. The service reserves quota, then writes/fsyncs its own same-directory
      // stage file before atomically publishing the final id-keyed path.
      fileFilter: (_req, file, cb) => {
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TO_EXT, file.mimetype)) {
          cb(new BadRequestException('Unsupported file type — allowed: image/png, image/jpeg, image/webp'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async upload(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @UploadedFile() file: MulterFile | undefined,
    @Body() body: AttachmentUploadDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw new BadRequestException('Missing file (multipart field "file")');

    const minRole = body.kind === 'portrait' ? 'player' : 'dm';
    const role = await this.access.requireRole(user, campaignId, minRole);

    return this.attachmentsService.create(campaignId, body.kind, file, user, role, body);
  }

  /**
   * List a campaign's attachments (issue #97 — there was no listing endpoint, so
   * the reveal/handouts flow had nothing to drive off). Any member may list, but
   * hidden (DM-only, unrevealed) attachments are dropped for non-DM roles via
   * filterHidden — same wholesale-secrecy treatment as hidden quests/npcs (#42),
   * so a player's list never even hints at a staged handout's existence.
   */
  @Get()
  @ApiOperation({ summary: 'List campaign attachments', description: 'Requires membership. Hidden (DM-only) attachments are omitted for non-DM roles.' })
  @ApiResponse({ status: 200, description: 'Attachments for the campaign (hidden ones filtered out for non-DM).' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    const all = await this.attachmentsService.listForCampaign(campaignId);
    if (role === 'dm') return all;
    // A map already revealed as a handout may later be attached to a fogged
    // encounter. Hide it dynamically as well as honoring row.hidden so legacy or
    // reused attachments cannot disclose the raw board through this list.
    const protectedIds = await this.attachmentsService.fogProtectedMapIdsForCampaign(campaignId);
    return filterHidden(all.filter((attachment) => !protectedIds.has(attachment.id)), role);
  }
}

@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Streams the file bytes. Requires campaign membership — never a public URL.
   *
   * Attachment bytes are write-once, but authorization is mutable: a handout can
   * be hidden again or become a fog-protected encounter map (issue #463 / #498).
   * Responses therefore carry a strong content-hash `ETag` with mandatory
   * revalidation (`Cache-Control: private, no-cache, must-revalidate`), never a
   * long-lived immutable grant. A matching authorized `If-None-Match` still
   * short-circuits to 304 without re-downloading an unchanged multi-MB image.
   * `Vary: Cookie` is a defensive keying hint for shared/proxy caches; clients
   * should also append `?v=<versionToken>` so an authorization change yields a
   * new URL and the browser cache misses.
   *
   * `?size=thumb|md|lg` serves a durable responsive derivative (issue #604) —
   * generated once, off the request path, by AttachmentDerivativesService. When
   * no rung is ready yet (or the source is already small enough, or generation
   * failed) the ORIGINAL is served as a documented last resort and the
   * `X-Campfire-Derivative` header says `original-fallback` so the client can
   * show a processing/error state instead of silently believing it got a small
   * image. Omitting `size` (or `?download=1`) is the explicit "give me the
   * untouched original" path the DM needs for printing/VTT export.
   */
  @Get(':id/file')
  @ApiOperation({ summary: 'Stream attachment bytes', description: 'Requires campaign membership — attachment files are never served from a public URL. Responses carry a strong ETag but must revalidate authorization and visibility before reuse; a matching authorized If-None-Match returns 304. `?size=thumb|md|lg` serves a durable responsive derivative (issue #604); the `X-Campfire-Derivative` header names the rung actually served, or `original-fallback` when no derivative was available. `?download=1` sends Content-Disposition: attachment for a download of the original.' })
  @ApiQuery({ name: 'size', required: false, enum: [...DERIVATIVE_VARIANT_NAMES], description: 'Omit for the full-size original; `thumb` (512px), `md` (1280px) or `lg` (2560px) cap the longest edge.' })
  @ApiQuery({ name: 'download', required: false, enum: ['1'], description: 'Set to 1 to force a download with Content-Disposition: attachment.' })
  @ApiQuery({ name: 'v', required: false, type: String, description: 'Authorization-aware version token (see AttachmentsService.versionToken). Optional but recommended — clients should append it so a content/hidden change produces a new URL.' })
  @ApiResponse({ status: 200, description: 'Raw file bytes, with Content-Type/Content-Disposition/ETag set from the stored attachment.' })
  @ApiResponse({ status: 304, description: 'Client cache is current (If-None-Match matched the ETag).' })
  @ApiResponse({ status: 400, description: 'Unsupported `size` value.' })
  @ApiResponse({ status: 404, description: 'Attachment not found or hidden.' })
  async getFile(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res() res: Response,
    @Query('size') size?: string,
    @Query('download') download?: string,
  ) {
    if (size !== undefined && !isDerivativeVariantName(size)) {
      throw new BadRequestException(
        `Unsupported size — allowed: ${DERIVATIVE_VARIANT_NAMES.map((v) => `'${v}'`).join(', ')} (or omit for the original)`,
      );
    }
    if (download !== undefined && download !== '1') {
      throw new BadRequestException("Unsupported download — allowed: '1' (or omit for inline)");
    }
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);

    // Issue #97/#463: a hidden (DM-only, unrevealed) attachment must be indistinguishable
    // from a nonexistent one for non-DM members — otherwise sequential integer ids
    // let a player enumerate & fetch every staged handout. 404 (not 403) so the
    // response leaks nothing about whether the id exists, matching how hidden
    // quests/npcs are treated (#42). The DM reveals it (POST :id/reveal) to share.
    if (role !== 'dm') {
      // There is deliberately NO encounter-map exception here. A player obtains a
      // role-specific image through GET /encounters/:id/map; direct originals,
      // thumbnails, conditional requests, and Range probes all fail before bytes or
      // validators are exposed. Hidden rows 404 immediately; fog only checked for
      // visible legacy/reused maps that may still conceal source pixels.
      if (row.hidden) throw new NotFoundException(`Attachment ${id} not found`);
      const fogProtected = await this.attachmentsService.isFogProtectedEncounterMap(id, row.campaignId);
      if (fogProtected) throw new NotFoundException(`Attachment ${id} not found`);
    }

    // Issue #84: the DB row can outlive its bytes on disk — an orphaned row from a
    // failed write, a restore that didn't carry the uploads/ dir, or a lossy import.
    // Verify the original file is present *before* resolveFile() (which reads it to
    // hash the ETag), so a missing file becomes a clean catchable 404 instead of a
    // 500, and the stream below can never hit a listener-less ENOENT that crashes
    // the process. Since #604 resolveFile no longer DECODES anything on this path —
    // it looks up the best ready derivative in an indexed table — but it still
    // needs the original present for the fallback + ETag.
    await this.assertFileReadable(this.attachmentsService.filePath(row), id);

    const variant: RequestedSize = size !== undefined && isDerivativeVariantName(size) ? size : 'original';
    const file = this.attachmentsService.resolveFile(row, variant);

    // Issue #498 — honest cache policy for a permission-dependent resource. See the
    // method doc above for the full rationale: no `immutable` (the browser must keep
    // revalidating so the membership check runs), long `max-age` + strong ETag for
    // 304 short-circuits, `private` so no shared proxy caches it, and `Vary: Cookie`
    // as a defensive keying hint. The versioned URL (?v=) the client appends is what
    // actually defeats cross-authorization-state cache hits.
    res.set({
      'Cache-Control': 'private, no-cache, must-revalidate',
      Vary: 'Cookie, Authorization, x-dev-role, x-dev-user',
      ETag: file.etag,
      // Issue #604: name the rung actually served ('thumb'|'md'|'lg'|'original'),
      // or 'original-fallback' when the requested rung was not available. Set
      // BEFORE the 304 short-circuit so a revalidating client still learns that a
      // derivative has since become ready and can re-request a smaller URL.
      'X-Campfire-Derivative': file.derivative,
    });

    if (ifNoneMatchSatisfied(req.headers['if-none-match'], file.etag)) {
      res.status(304).end();
      return;
    }

    res.set({
      'Content-Type': file.mime,
      'Content-Length': String(file.size),
      // Issue #630: ASCII fallback + RFC 5987 filename* (not percent-encoding
      // the Unicode name into the legacy filename= slot).
      'Content-Disposition': contentDispositionHeader(row.filename, download === '1' ? 'attachment' : 'inline'),
    });

    const stream = fs.createReadStream(file.path);
    // Backstop for the TOCTOU window (file deleted between the stat check and the read)
    // and any mid-stream read error. Without an 'error' listener the error is rethrown
    // as an uncaught exception; with one, we answer 404 if headers aren't sent yet,
    // else tear down the socket.
    stream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.status(404).end();
      }
    });
    stream.pipe(res);
  }

  @Patch(':id/metadata')
  @ApiOperation({ summary: 'Correct attachment attribution and accessibility metadata', description: 'Requires the uploader or a DM. Bytes and visibility are immutable through this endpoint; updatedAt prevents overwriting a newer correction.' })
  async updateMetadata(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AttachmentMetadataUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.attachmentsService.updateMetadata(id, body, user, role);
  }

  /**
   * Responsive-delivery manifest (issue #604).
   *
   * This is what lets a map surface render honest LOADING / STALE / ERROR states
   * instead of pretending an original-sized fallback is a derivative: it reports
   * per-rung `state` (pending / ready / failed / skipped), the real pixel
   * dimensions of every ready rung (so the client can emit an accurate `srcset`
   * with `w` descriptors rather than guessing from the max-dim cap), and a
   * `stale` flag when a rung was generated from source bytes that have since been
   * replaced.
   *
   * Authorization is identical to the bytes route — including the hidden/fog
   * checks — because "how many rungs does this map have" is itself a hint about a
   * staged handout's existence (#97/#463).
   */
  @Get(':id/derivatives')
  @ApiOperation({
    summary: 'Responsive derivative status for an attachment',
    description:
      'Requires campaign membership; hidden or fog-protected attachments 404 for non-DMs exactly as the bytes route does. ' +
      'Returns per-rung state (pending/ready/failed/skipped) plus the real pixel dimensions of ready rungs, so a client can ' +
      'build a correct srcset and show processing/stale/error states.',
  })
  @ApiResponse({ status: 200, description: 'Derivative manifest.' })
  @ApiResponse({ status: 404, description: 'Attachment not found or hidden.' })
  async derivatives(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.requireReadableAttachment(id, user);
    return this.attachmentsService.derivativeManifest(row);
  }

  /**
   * Recovery action for a failed or stale ladder (issue #604) — the "Retry" the
   * map surfaces offer when generation errored.
   *
   * dm-only: regenerating is real CPU + disk work, and the DM is the person who
   * owns the map. Re-plans from the CURRENT source header (so it also fixes a
   * ladder that went stale after a restore) and returns the fresh manifest, which
   * flips the UI straight to "processing" without waiting for a poll.
   */
  @Post(':id/derivatives/retry')
  @ApiOperation({
    summary: 'Regenerate an attachment\'s responsive derivatives',
    description: 'dm role required. Resets the ladder and schedules background regeneration; returns the new manifest.',
  })
  @ApiResponse({ status: 201, description: 'Ladder re-planned; generation runs in the background.' })
  async retryDerivatives(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    await this.access.requireRole(user, row.campaignId, 'dm');
    return this.attachmentsService.retryDerivatives(row);
  }

  /**
   * Shared authorization preamble for the read-only derivative routes: membership,
   * then the same hidden/fog secrecy rules the bytes route applies (see getFile).
   * Kept as one helper so a future route cannot accidentally expose a staged
   * handout's metadata by forgetting one of the two checks.
   */
  private async requireReadableAttachment(id: number, user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    if (role !== 'dm') {
      if (row.hidden) throw new NotFoundException(`Attachment ${id} not found`);
      if (await this.attachmentsService.isFogProtectedEncounterMap(id, row.campaignId)) {
        throw new NotFoundException(`Attachment ${id} not found`);
      }
    }
    return row;
  }

  /**
   * Throw 404 unless `filePath` names an existing regular file. Runs before any
   * response bytes are sent so a missing file is a catchable Nest exception rather
   * than a fatal stream error (issue #84).
   */
  private async assertFileReadable(filePath: string, id: number): Promise<void> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new NotFoundException(`Attachment ${id} file is missing`);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new NotFoundException(`Attachment ${id} file is missing`);
    }
  }

  /**
   * Reveal a staged handout to the party (issue #97): flips hidden=false so every
   * member can now fetch the file / see it in the campaign list. dm-only — this is
   * the DM's prep→reveal moment. Returns the updated attachment.
   */
  @Post(':id/reveal')
  @ApiOperation({ summary: 'Reveal an attachment to players', description: 'dm role required. Clears the DM-only flag so all campaign members can fetch the file.' })
  @ApiResponse({ status: 201, description: 'Updated attachment (hidden=false).' })
  async reveal(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    if (await this.attachmentsService.isFogProtectedEncounterMap(id, row.campaignId)) {
      throw new ConflictException('This attachment is protecting a fogged encounter map — reveal the full board or disable fog first');
    }
    return this.attachmentsService.setHidden(id, false, user, role);
  }

  /**
   * Re-hide an attachment (issue #97): flips hidden=true, pulling it back to
   * DM-only. Lets a DM stage previously-shared or legacy-visible material. dm-only.
   */
  @Post(':id/hide')
  @ApiOperation({ summary: 'Hide an attachment from players', description: 'dm role required. Sets the DM-only flag so non-DM members can no longer fetch or list the file.' })
  @ApiResponse({ status: 201, description: 'Updated attachment (hidden=true).' })
  async hide(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.attachmentsService.setHidden(id, true, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an attachment', description: 'Requires campaign membership; the service layer further restricts to the uploader or a dm.' })
  @ApiResponse({ status: 200, description: 'Metadata removed; filesystem erasure verified unless filesPending is true.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    // Issue #1636: `requireMember(..., { write: true })` only asserts the CAMPAIGN is
    // writable, not that the CALLER has write authority — it returns a viewer's role
    // unchanged. The service's ownership check below (`uploaderUserId === user.id`) is
    // untouched by a role change, so a member demoted from player to viewer kept the
    // ability to delete files they uploaded while a player. requireRole('player') closes
    // that; the service-layer uploader-or-dm check still applies on top.
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    const outcome = await this.attachmentsService.remove(id, user, role);
    return { filesPending: outcome.filesPending, pendingPaths: outcome.pendingPaths };
  }
}
