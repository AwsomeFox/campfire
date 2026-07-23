import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { BackupService, RESTORE_CONFIRM_TOKEN } from './backup.service';

// Express.Multer.File augments the Express namespace via @types/multer; import side-effect only.
type MulterFile = Express.Multer.File;

/** A restored archive can be large (whole DB + all uploads). 1 GB ceiling. */
const MAX_RESTORE_BYTES = 1024 * 1024 * 1024;

@ApiTags('backup')
@Controller('backup')
@ServerRoles('admin')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  @ApiOperation({
    summary: 'Download a whole-server backup',
    description:
      'Server-admin only. Returns a zip archive containing a WAL-safe snapshot of the SQLite database (via VACUUM INTO) plus every uploaded file, with a manifest.',
  })
  @ApiResponse({ status: 200, description: 'Zip file download (application/zip, Content-Disposition attachment).' })
  async download(@Res() res: Response): Promise<void> {
    const buffer = await this.backup.buildBackup();
    res
      .status(200)
      .set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${this.backup.backupFilename()}"`,
        'Content-Length': String(buffer.length),
        // Issue #730: never let browsers / the PWA Cache Storage retain a whole-server archive.
        'Cache-Control': 'private, no-store',
      })
      .end(buffer);
  }

  @Post('inspect')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Inspect a backup archive (non-destructive)',
    description:
      'Server-admin only. Parses manifest.json and lists upload paths without restoring or modifying the live server.',
  })
  @ApiResponse({ status: 200, description: 'Manifest metadata and upload listing.' })
  @ApiResponse({ status: 400, description: 'Malformed or invalid archive.' })
  @ApiResponse({ status: 403, description: 'Not a server admin.' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RESTORE_BYTES } }))
  async inspect(@UploadedFile() file: MulterFile | undefined) {
    if (!file) throw new BadRequestException('Missing backup archive (multipart field "file")');
    return this.backup.inspect(file.buffer);
  }

  @Post('restore')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Restore a whole-server backup',
    description:
      `Server-admin only. DESTRUCTIVE — replaces the entire database and uploads with the contents of the uploaded archive. ` +
      `The multipart body must include the archive as field "file" and a field "confirm" equal to "${RESTORE_CONFIRM_TOKEN}". ` +
      `The archive is fully validated before anything is overwritten; a malformed archive is rejected (400) with the server untouched.`,
  })
  @ApiResponse({ status: 200, description: 'Restore applied. Returns a summary of what was restored.' })
  @ApiResponse({ status: 400, description: 'Missing/invalid confirmation token, or malformed/invalid archive.' })
  @ApiResponse({ status: 403, description: 'Not a server admin.' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RESTORE_BYTES } }))
  async restore(
    @UploadedFile() file: MulterFile | undefined,
    @Body('confirm') confirm: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw new BadRequestException('Missing backup archive (multipart field "file")');
    return this.backup.restore(file.buffer, confirm, user);
  }
}
