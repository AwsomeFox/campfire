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
      'Server-admin only. Returns a zip archive containing a WAL-safe snapshot of the SQLite database (via VACUUM INTO) plus every uploaded file, with a manifest. ' +
      'To include the auto-generated AI credential encryption keyfile as an encrypted envelope (issue #496), use POST /backup/download with a JSON body instead — passphrases must not travel in query strings. ' +
      'Without the envelope, a restore to a fresh DATA_DIR cannot decrypt stored provider API keys unless the operator has set AI_CONFIG_KEY out-of-band.',
  })
  @ApiResponse({ status: 200, description: 'Zip file download (application/zip, Content-Disposition attachment).' })
  async download(@Res() res: Response): Promise<void> {
    await this.sendBackup(res);
  }

  @Post('download')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Download a whole-server backup (with optional key envelope passphrase)',
    description:
      'Server-admin only. Same archive as GET /backup, but accepts the issue-#496 keyfile envelope passphrase in the POST body so it is not logged in query strings or browser history. ' +
      `The passphrase MUST be at least 12 characters; short values are rejected before the archive is produced.`,
  })
  @ApiResponse({ status: 200, description: 'Zip file download (application/zip, Content-Disposition attachment).' })
  async downloadWithKeyEnvelope(
    @Res() res: Response,
    @Body('keyPassphrase') keyPassphrase?: string,
  ): Promise<void> {
    await this.sendBackup(res, keyPassphrase);
  }

  private async sendBackup(res: Response, keyPassphrase?: string): Promise<void> {
    const buffer = await this.backup.buildBackup(
      keyPassphrase && keyPassphrase.length > 0 ? { keyPassphrase } : undefined,
    );
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
      `The archive is fully validated before anything is overwritten; a malformed archive is rejected (400) with the server untouched. ` +
      `When the archive carries an encrypted AI keyfile envelope (issue #496), pass "keyPassphrase" with the passphrase used when the ` +
      `backup was cut so stored provider credentials remain decryptable after restore. Wrong passphrase → 400, server untouched.`,
  })
  @ApiResponse({ status: 200, description: 'Restore applied. Returns a summary of what was restored.' })
  @ApiResponse({ status: 400, description: 'Missing/invalid confirmation token, or malformed/invalid archive.' })
  @ApiResponse({ status: 403, description: 'Not a server admin.' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RESTORE_BYTES } }))
  async restore(
    @UploadedFile() file: MulterFile | undefined,
    @Body('confirm') confirm: string | undefined,
    @Body('keyPassphrase') keyPassphrase: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw new BadRequestException('Missing backup archive (multipart field "file")');
    return this.backup.restore(file.buffer, confirm, user, keyPassphrase ? { keyPassphrase } : undefined);
  }
}
