import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import fs from 'node:fs';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AttachmentsService, ALLOWED_MIME_TO_EXT, MAX_UPLOAD_BYTES } from './attachments.service';
import { AttachmentUploadDto } from './attachments.dto';

// Express.Multer.File augments the Express namespace via @types/multer; import side-effect only.
type MulterFile = Express.Multer.File;

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
   */
  @Post()
  @ApiConsumes('multipart/form-data')
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
}

@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly access: CampaignAccessService,
  ) {}

  /** Streams the file bytes. Requires campaign membership — never a public URL. */
  @Get(':id/file')
  async getFile(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser, @Res() res: Response) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);

    const filePath = this.attachmentsService.filePath(row);
    res.set({
      'Content-Type': row.mime,
      'Content-Length': String(row.size),
      'Content-Disposition': `inline; filename="${encodeURIComponent(row.filename)}"`,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    fs.createReadStream(filePath).pipe(res);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.attachmentsService.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    await this.attachmentsService.remove(id, user, role);
  }
}
