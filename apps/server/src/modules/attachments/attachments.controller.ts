import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
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
import { AttachmentUploadDto } from './attachments.dto';
import { contentDispositionHeader } from './filename';

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
  @ApiOperation({ summary: 'Upload an attachment', description: "Multipart upload. `kind` in the form body selects the bucket and minimum role: player+ for 'portrait', dm-only for 'map'/'image'. Allowed mime types: image/png, image/jpeg, image/webp." })
  @ApiResponse({ status: 201, description: 'Attachment created.' })
  @ApiResponse({ status: 400, description: 'Missing file, unsupported mime type, or file content that does not match the declared type.' })
  @ApiResponse({ status: 413, description: 'File exceeds the max upload size.' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      // No `storage` option -> multer defaults to MemoryStorage, giving us file.buffer
      // directly (no temp file). We write the final bytes ourselves, keyed by the new
      // attachment row's id (see AttachmentsService.create / filePath).
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

    return this.attachmentsService.create(campaignId, body.kind, file, user, role);
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
    return filterHidden(all, role);
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
   * Cache policy (issue #498): attachment bytes are immutable for a given id
   * (write-once, deleted with the row), so responses carry a strong content-hash
   * `ETag` and a long-lived `Cache-Control: private, max-age=...`. BUT this is a
   * permission-dependent resource — the same id can be readable by one user and
   * 403/404 for another (membership removed, hidden toggled, login-as-other-user
   * in the same browser). A plain immutable cache would serve the previously-fetched
   * bytes straight from the browser HTTP cache without the membership check ever
   * running, leaking them across authorization states. Two guards make the cache
   * honest instead:
   *
   *   1. No `immutable` directive. The browser may still reuse a fresh (in-window)
   *      cached response without revalidation, but without `immutable` it will
   *      revalidate once the entry is stale (or on reload/force-reload) rather than
   *      serving it indefinitely — so the membership/hidden check on this handler
   *      runs at stale boundaries and on any reload. The durable authorization
   *      guarantee comes from guard (2): the URL itself changes when authorization
   *      state changes, so the browser cache misses and the request hits the server.
   *      A matching ETag still short-circuits to 304, so an unchanged multi-MB map
   *      isn't re-downloaded.
   *   2. Content-versioned URLs. The web client appends `?v=<versionToken>` (see
   *      AttachmentsService.versionToken), a deterministic hash over
   *      `(id | hidden | updatedAt)`. When the authorization state changes (hidden
   *      toggled, id restored/reused with a new updatedAt) the URL itself changes,
   *      the browser cache misses, and the request hits the server — where the
   *      membership/hidden check runs and a now-unauthorized caller gets 403/404
   *      instead of stale bytes. `Vary: Cookie` is a belt-and-suspenders
   *      hint so shared/proxy caches key on the session too (browsers mostly ignore
   *      Vary for the HTTP cache, which is exactly why the versioned URL is the
   *      real fix).
   *
   * `?size=thumb` serves a downscaled PNG preview for list/dashboard use (see
   * AttachmentsService.resolveFile / thumbnail.ts).
   */
  @Get(':id/file')
  @ApiOperation({ summary: 'Stream attachment bytes', description: 'Requires campaign membership — attachment files are never served from a public URL. Hidden (DM-only) attachments return 404 for non-DM roles, except encounter maps when fog is fully revealed (fog === null). Responses are privately cacheable (strong ETag + long-lived Cache-Control, no `immutable` so revalidation still runs the auth check); a matching If-None-Match returns 304. Clients should append `?v=<versionToken>` (from the attachment row) so an authorization change yields a new URL. `?size=thumb` serves a downscaled PNG preview.' })
  @ApiQuery({ name: 'size', required: false, enum: ['thumb'], description: 'Omit for the full-size original; `thumb` for a downscaled PNG preview.' })
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
  ) {
    if (size !== undefined && size !== 'thumb') {
      throw new BadRequestException("Unsupported size — allowed: 'thumb' (or omit for the original)");
    }
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);

    // Issue #97 / #523: a hidden (DM-only, unrevealed) attachment must be indistinguishable
    // from a nonexistent one for non-DM members — otherwise sequential integer ids
    // let a player enumerate & fetch every staged handout. 404 (not 403) so the
    // response leaks nothing about whether the id exists, matching how hidden
    // quests/npcs are treated (#42). The DM reveals it (POST :id/reveal) to share.
    // Encounter map attachments are gated on role === 'dm' OR fog === null (fully revealed map);
    // non-DM GET on a hidden encounter map with active fog (fog !== null) returns 404.
    if (row.hidden && role !== 'dm') {
      const mapFog = await this.attachmentsService.getEncounterMapFog(id, row.campaignId);
      if (!mapFog.isMap || mapFog.fog !== null) {
        throw new NotFoundException(`Attachment ${id} not found`);
      }
    }

    // Issue #84: the DB row can outlive its bytes on disk — an orphaned row from a
    // failed write, a restore that didn't carry the uploads/ dir, or a lossy import.
    // Verify the original file is present *before* resolveFile() (which reads it to
    // hash the ETag, and — for ?size=thumb — to generate the thumbnail), so a missing
    // file becomes a clean catchable 404 instead of a 500, and the stream below can
    // never hit a listener-less ENOENT that crashes the process.
    await this.assertFileReadable(this.attachmentsService.filePath(row), id);

    const variant = size === 'thumb' ? 'thumb' : 'original';
    const file = this.attachmentsService.resolveFile(row, variant);

    // Issue #498 — honest cache policy for a permission-dependent resource. See the
    // method doc above for the full rationale: no `immutable` (the browser must keep
    // revalidating so the membership check runs), long `max-age` + strong ETag for
    // 304 short-circuits, `private` so no shared proxy caches it, and `Vary: Cookie`
    // as a defensive keying hint. The versioned URL (?v=) the client appends is what
    // actually defeats cross-authorization-state cache hits.
    res.set({
      'Cache-Control': 'private, max-age=31536000',
      Vary: 'Cookie',
      ETag: file.etag,
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
      'Content-Disposition': contentDispositionHeader(row.filename, 'inline'),
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
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    await this.attachmentsService.remove(id, user, role);
  }
}
